import 'server-only'
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
 * Idempotent per artifact + processing_version: a completed run is a no-op;
 * a run already in flight (started within the last 2 minutes) is skipped
 * rather than duplicating an LLM call and a set of observation rows.
 *
 * Audio/video/spreadsheet are NOT pretended to work — they are marked
 * processing_status='unsupported' with the original bytes fully preserved.
 * This is the designed hook future audio/video processors plug into: same
 * function signature, same artifact row, same observation table.
 */

const IN_FLIGHT_GUARD_MS = 2 * 60 * 1000

export type ProcessArtifactResult =
  | { ok: true; status: 'completed' | 'unsupported'; skipped: boolean }
  | { ok: false; status: 'failed'; error: string }

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

  if (artifact.processing_status === 'completed' || artifact.processing_status === 'unsupported') {
    return { ok: true, status: artifact.processing_status, skipped: true }
  }
  if (
    artifact.processing_status === 'processing' &&
    Date.now() - new Date(artifact.updated_at).getTime() < IN_FLIGHT_GUARD_MS
  ) {
    return { ok: true, status: 'completed', skipped: true }
  }

  await supabase
    .from('business_artifacts')
    .update({ processing_status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', artifactId)

  try {
    if (artifact.modality === 'image') {
      await processImage(supabase, artifact)
    } else if (artifact.modality === 'document') {
      await processDocument(supabase, artifact)
    } else {
      await markUnsupported(supabase, artifact)
      return { ok: true, status: 'unsupported', skipped: false }
    }

    await supabase
      .from('business_artifacts')
      .update({
        processing_status: 'completed',
        processing_error: null,
        processing_completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', artifactId)
    return { ok: true, status: 'completed', skipped: false }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await supabase
      .from('business_artifacts')
      .update({
        processing_status: 'failed',
        processing_error: message.slice(0, 1000),
        updated_at: new Date().toISOString(),
      })
      .eq('id', artifactId)
    return { ok: false, status: 'failed', error: message }
  }
}

async function markUnsupported(
  supabase: ReturnType<typeof createServiceClient>,
  artifact: BusinessArtifactRow
): Promise<void> {
  await supabase.from('business_artifacts').update({
    processing_status: 'unsupported',
    processing_error: `${artifact.modality} understanding is not yet implemented — original bytes are preserved.`,
    processing_completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', artifact.id)
}

async function processImage(
  supabase: ReturnType<typeof createServiceClient>,
  artifact: BusinessArtifactRow
): Promise<void> {
  const bytes = await downloadArtifactBytes(artifact.storage_path)
  if (!bytes) throw new Error('could not download artifact bytes from storage')

  const result = await describeImage({
    base64: bytes.toString('base64'),
    mimeType: artifact.detected_mime_type ?? 'image/jpeg',
    caption: null,
    workspaceId: artifact.workspace_id,
  })
  if (!result.ok) throw new Error(result.reason)

  await supabase.from('business_artifact_observations').insert({
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
    model_version: `image-v${artifact.processing_version}`,
  })

  if (result.value.visible_text) {
    await supabase.from('business_artifact_observations').insert({
      artifact_id: artifact.id,
      workspace_id: artifact.workspace_id,
      observation_type: 'visible_text',
      modality: 'image',
      content: { text: result.value.visible_text },
      confidence: result.value.confidence,
      provenance_status: 'extracted',
      derived_by: 'model:claude-sonnet-4-6',
      model_version: `image-v${artifact.processing_version}`,
    })
  }
}

async function processDocument(
  supabase: ReturnType<typeof createServiceClient>,
  artifact: BusinessArtifactRow
): Promise<void> {
  if (artifact.detected_mime_type !== 'application/pdf') {
    await markUnsupported(supabase, artifact)
    return
  }

  const bytes = await downloadArtifactBytes(artifact.storage_path)
  if (!bytes) throw new Error('could not download artifact bytes from storage')

  const result = await extractDocument({
    base64: bytes.toString('base64'),
    mimeType: artifact.detected_mime_type,
    workspaceId: artifact.workspace_id,
  })
  if (!result.ok) throw new Error(result.reason)

  await supabase.from('business_artifact_observations').insert({
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
    model_version: `document-v${artifact.processing_version}`,
  })

  await supabase.from('business_artifact_observations').insert({
    artifact_id: artifact.id,
    workspace_id: artifact.workspace_id,
    observation_type: 'summary',
    modality: 'document',
    content: { summary: result.value.summary },
    confidence: null,
    provenance_status: 'extracted',
    derived_by: 'model:claude-sonnet-4-6',
    model_version: `document-v${artifact.processing_version}`,
  })
}
