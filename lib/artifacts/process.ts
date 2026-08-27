import 'server-only'
import crypto from 'node:crypto'
import { createServiceClient } from '@/lib/supabase-server'
import { downloadArtifactBytes } from './storage'
import { describeImage, extractDocument } from './understand'
import type { BusinessArtifactRow } from './types'

/**
 * Shared artifact understanding processor (#87).
 *
 * ONE code path, callable two ways:
 *   - inline, synchronously, right after ingestion (fast enough for a
 *     single image/PDF that the operator is waiting on a reply for)
 *   - from the caye_pending_operations worker (lib/pending-operations-worker.ts,
 *     operation='artifact_process') — the durable retry/reprocess path, and
 *     the ONLY path for channels that don't do an inline pass.
 *
 * Because both callers can run at once (the queue's own claim/lease only
 * protects one caye_pending_operations ROW from being double-claimed — it
 * says nothing about two DIFFERENT rows, or an inline call, targeting the
 * SAME artifact concurrently), the artifact itself needs its own
 * compare-and-set claim. This mirrors caye_pending_operations' claim_token/
 * claimed_at lease exactly: only the caller that wins the atomic
 * UPDATE ... WHERE processing_status IN ('pending','failed') ... may run the
 * model and write observations; a lease that outlives the reap window is
 * treated as a crashed worker and reset so the row becomes claimable again.
 *
 * Never runs ahead of storage: processing_status never leaves 'pending'
 * until storage_state='stored' (see ingest.ts) — a row whose bytes were
 * never confirmed durable is refused here, not silently processed.
 *
 * Audio/video/spreadsheet/non-PDF documents are NOT pretended to work — they
 * are marked processing_status='unsupported' with the original bytes fully
 * preserved, decided BEFORE any model call and BEFORE the claim is released,
 * so 'unsupported' can never be overwritten by a trailing 'completed' write.
 */

/** How long a processing lease is honored before being treated as an abandoned/crashed worker. */
const LEASE_MS = 5 * 60 * 1000

export type ProcessArtifactResult =
  | { ok: true; status: 'completed' | 'unsupported' | 'processing'; skipped: boolean }
  | { ok: false; status: 'failed'; error: string }

/** Resets a lease older than LEASE_MS back to 'failed' so it becomes claimable again. Never touches a live (in-window) lease. */
async function reapStaleClaim(supabase: ReturnType<typeof createServiceClient>, artifactId: string): Promise<void> {
  await supabase
    .from('business_artifacts')
    .update({
      processing_status: 'failed',
      processing_claim_token: null,
      processing_claimed_at: null,
      processing_error: 'stale processing claim reset — worker likely crashed mid-run',
      updated_at: new Date().toISOString(),
    })
    .eq('id', artifactId)
    .eq('processing_status', 'processing')
    .lt('processing_claimed_at', new Date(Date.now() - LEASE_MS).toISOString())
}

/**
 * Atomic compare-and-set claim. Only a row currently 'pending' or 'failed'
 * (for the version read just before this call) can be claimed, and the
 * claim itself is the conditional UPDATE — not a separate read-then-write —
 * so two concurrent callers can never both win it.
 */
async function claimForProcessing(
  supabase: ReturnType<typeof createServiceClient>,
  artifactId: string,
  processingVersion: number
): Promise<{ artifact: BusinessArtifactRow; token: string } | null> {
  await reapStaleClaim(supabase, artifactId)

  const token = crypto.randomUUID()
  const { data } = await supabase
    .from('business_artifacts')
    .update({
      processing_status: 'processing',
      processing_claim_token: token,
      processing_claimed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', artifactId)
    .eq('processing_version', processingVersion)
    .in('processing_status', ['pending', 'failed'])
    .select('*')

  const row = (data as BusinessArtifactRow[] | null)?.[0]
  if (!row) return null
  return { artifact: row, token }
}

/** Only the current lease holder (matching claim_token) may release it. A stale/reclaimed lease silently loses this — by design. */
async function releaseClaim(
  supabase: ReturnType<typeof createServiceClient>,
  artifactId: string,
  token: string,
  finalStatus: 'completed' | 'unsupported' | 'failed',
  processingError: string | null
): Promise<void> {
  await supabase
    .from('business_artifacts')
    .update({
      processing_status: finalStatus,
      processing_claim_token: null,
      processing_claimed_at: null,
      processing_error: processingError,
      processing_completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', artifactId)
    .eq('processing_claim_token', token)
}

export async function processArtifact(artifactId: string): Promise<ProcessArtifactResult> {
  const supabase = createServiceClient()
  const { data: row, error: fetchError } = await supabase
    .from('business_artifacts')
    .select('*')
    .eq('id', artifactId)
    .maybeSingle()

  if (fetchError || !row) {
    return { ok: false, status: 'failed', error: fetchError?.message ?? 'artifact not found' }
  }
  const artifact = row as BusinessArtifactRow

  // Never process ahead of confirmed storage — a row can exist with no
  // durable bytes behind it (see ingest.ts). Understanding must wait for a
  // fresh ingest call to actually store the bytes first.
  if (artifact.storage_state !== 'stored') {
    return { ok: false, status: 'failed', error: 'artifact bytes are not yet confirmed durable in storage' }
  }

  if (artifact.processing_status === 'completed' || artifact.processing_status === 'unsupported') {
    return { ok: true, status: artifact.processing_status, skipped: true }
  }

  const claim = await claimForProcessing(supabase, artifactId, artifact.processing_version)
  if (!claim) {
    // Lost the race: another caller (inline vs. queue, or two queue drains)
    // already claimed this artifact+version, or it just finished under us.
    // Never claim to have completed work we didn't do — report the row's
    // OWN current status instead of guessing.
    const { data: current } = await supabase.from('business_artifacts').select('processing_status').eq('id', artifactId).maybeSingle()
    const status = (current?.processing_status as 'completed' | 'unsupported' | undefined) ?? 'processing'
    return { ok: true, status, skipped: true }
  }

  try {
    let finalStatus: 'completed' | 'unsupported'
    let processingError: string | null = null

    if (claim.artifact.modality === 'image') {
      await processImage(supabase, claim.artifact)
      finalStatus = 'completed'
    } else if (claim.artifact.modality === 'document' && claim.artifact.detected_mime_type === 'application/pdf') {
      await processDocument(supabase, claim.artifact)
      finalStatus = 'completed'
    } else {
      finalStatus = 'unsupported'
      processingError = `${claim.artifact.modality} understanding is not yet implemented — original bytes are preserved.`
    }

    await releaseClaim(supabase, artifactId, claim.token, finalStatus, processingError)
    return { ok: true, status: finalStatus, skipped: false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await releaseClaim(supabase, artifactId, claim.token, 'failed', message.slice(0, 1000))
    return { ok: false, status: 'failed', error: message }
  }
}

/**
 * True for the unique-index violation on
 * (artifact_id, observation_type, model_version) WHERE superseded_at IS NULL
 * — i.e. another worker's insert for this exact observation already won.
 * This is the actual enforcement behind hasActiveModelObservation's
 * check-then-insert, which alone has a race window (a lease can expire
 * while a legitimate worker is still running; see the migration's comment
 * on this index). Losing this race is not a failure — it's the safety net
 * catching exactly the case it exists for.
 */
function isBenignDuplicateObservation(error: { code?: string } | null): boolean {
  return error?.code === '23505'
}

/** True when an active (non-superseded) model observation of this type/version already exists — guards against re-inserting a duplicate set after a claim/release race or a crash between insert and release. */
async function hasActiveModelObservation(
  supabase: ReturnType<typeof createServiceClient>,
  artifactId: string,
  observationType: string,
  modelVersion: string
): Promise<boolean> {
  const { data } = await supabase
    .from('business_artifact_observations')
    .select('id')
    .eq('artifact_id', artifactId)
    .eq('observation_type', observationType)
    .eq('model_version', modelVersion)
    .is('superseded_at', null)
    .limit(1)
  return !!data && data.length > 0
}

async function processImage(
  supabase: ReturnType<typeof createServiceClient>,
  artifact: BusinessArtifactRow
): Promise<void> {
  const modelVersion = `image-v${artifact.processing_version}`
  if (await hasActiveModelObservation(supabase, artifact.id, 'visual_description', modelVersion)) return

  const bytes = await downloadArtifactBytes(artifact.storage_path)
  if (!bytes) throw new Error('could not download artifact bytes from storage')

  const result = await describeImage({
    base64: bytes.toString('base64'),
    mimeType: artifact.detected_mime_type ?? 'image/jpeg',
    caption: null,
    workspaceId: artifact.workspace_id,
  })
  if (!result.ok) throw new Error(result.reason)

  const { error: descError } = await supabase.from('business_artifact_observations').insert({
    artifact_id: artifact.id,
    workspace_id: artifact.workspace_id,
    observation_type: 'visual_description',
    modality: 'image',
    content: {
      description: result.value.description,
      business_observations: result.value.business_observations,
    },
    confidence: result.value.confidence,
    provenance_status: 'observed',
    derived_by: 'model:claude-sonnet-4-6',
    model_version: modelVersion,
  })
  // Never let a partial write pass as success — releaseClaim must mark
  // 'failed' (retryable), not 'completed', when an observation didn't
  // actually land. hasActiveModelObservation's guard on retry means this
  // never inserts a duplicate description on the next attempt. A 23505 here
  // means another worker's insert already won this exact race — benign.
  if (descError && !isBenignDuplicateObservation(descError)) {
    throw new Error(`failed to save visual_description observation: ${descError.message}`)
  }

  if (result.value.visible_text) {
    const { error: textError } = await supabase.from('business_artifact_observations').insert({
      artifact_id: artifact.id,
      workspace_id: artifact.workspace_id,
      observation_type: 'visible_text',
      modality: 'image',
      content: { text: result.value.visible_text },
      confidence: result.value.confidence,
      provenance_status: 'extracted',
      derived_by: 'model:claude-sonnet-4-6',
      model_version: modelVersion,
    })
    if (textError && !isBenignDuplicateObservation(textError)) {
      throw new Error(`failed to save visible_text observation: ${textError.message}`)
    }
  }
}

async function processDocument(
  supabase: ReturnType<typeof createServiceClient>,
  artifact: BusinessArtifactRow
): Promise<void> {
  const modelVersion = `document-v${artifact.processing_version}`
  // Checked INDEPENDENTLY, not as a single upfront short-circuit: a prior
  // attempt may have inserted document_extraction and then failed before
  // summary (e.g. observation 9 in the adversarial list — model succeeds,
  // one insert fails). A retry must still land the missing piece, never
  // silently skip it just because the FIRST observation type already
  // exists — that would let 'completed' claim more progress than occurred.
  const hasExtraction = await hasActiveModelObservation(supabase, artifact.id, 'document_extraction', modelVersion)
  const hasSummary = await hasActiveModelObservation(supabase, artifact.id, 'summary', modelVersion)
  if (hasExtraction && hasSummary) return

  const bytes = await downloadArtifactBytes(artifact.storage_path)
  if (!bytes) throw new Error('could not download artifact bytes from storage')

  const result = await extractDocument({
    base64: bytes.toString('base64'),
    mimeType: artifact.detected_mime_type ?? 'application/pdf',
    workspaceId: artifact.workspace_id,
  })
  if (!result.ok) throw new Error(result.reason)

  if (!hasExtraction) {
    const { error: extractionError } = await supabase.from('business_artifact_observations').insert({
      artifact_id: artifact.id,
      workspace_id: artifact.workspace_id,
      observation_type: 'document_extraction',
      modality: 'document',
      content: {
        full_text: result.value.full_text,
        page_count: result.value.page_count,
        key_fields: result.value.key_fields,
      },
      confidence: null,
      provenance_status: 'extracted',
      derived_by: 'model:claude-sonnet-4-6',
      model_version: modelVersion,
    })
    if (extractionError && !isBenignDuplicateObservation(extractionError)) {
      throw new Error(`failed to save document_extraction observation: ${extractionError.message}`)
    }
  }

  if (!hasSummary) {
    const { error: summaryError } = await supabase.from('business_artifact_observations').insert({
      artifact_id: artifact.id,
      workspace_id: artifact.workspace_id,
      observation_type: 'summary',
      modality: 'document',
      content: { summary: result.value.summary },
      confidence: null,
      provenance_status: 'extracted',
      derived_by: 'model:claude-sonnet-4-6',
      model_version: modelVersion,
    })
    if (summaryError && !isBenignDuplicateObservation(summaryError)) {
      throw new Error(`failed to save summary observation: ${summaryError.message}`)
    }
  }
}
