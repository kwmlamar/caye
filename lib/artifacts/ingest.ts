import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { enqueueOperation } from '@/lib/pending-operations'
import {
  buildStoragePath,
  detectMimeType,
  sha256Hex,
  uploadArtifactBytes,
} from './storage'
import { processArtifact } from './process'
import { CHANNEL_SIZE_LIMITS_BYTES, modalityFromMimeType, type BusinessArtifactRow } from './types'

/**
 * Ingestion entry point for a durable business artifact (#87).
 *
 * Called synchronously from a channel's inbound handler (e.g. the WhatsApp
 * operator webhook's image/document branch) BEFORE the model ever sees the
 * bytes. Idempotent: the same provider attachment delivered twice (webhook
 * retry, duplicate message ingestion, reconnect replay) resolves to the SAME
 * artifact row rather than creating a second one.
 *
 * CANONICAL DB IDENTITY IS NOT THE SAME THING AS DURABLE BYTES. A row can
 * exist with no confirmed blob behind it (upload failed, or the process
 * crashed between the insert and the upload) — `storage_state` says which
 * is true, independently of `processing_status` (which is about
 * UNDERSTANDING, and never starts before storage_state='stored'):
 *
 *   storage_state:    'pending' → 'stored' | 'failed'
 *   processing_status: 'pending' → 'processing' → 'completed'/'unsupported'/'failed'
 *
 * A dedup hit is only ever reported as a genuine no-op when storage_state is
 * already 'stored'. Otherwise the SAME row is reused and the upload is
 * retried against these (possibly freshly re-delivered) bytes — a webhook
 * retry, or a retry after a mid-ingestion crash, self-heals through this
 * exact path. A second artifact row is never created for one provider
 * attachment id, whether the previous attempt failed, crashed, or is racing
 * concurrently with this one (the unique index makes a racing insert a
 * refetch-and-reuse, not a duplicate).
 *
 * Understanding is only ever enqueued once storage_state has just become
 * 'stored' in THIS call — never before, and the enqueue is itself idempotent
 * (stable idempotency key per artifact+processing_version), so a retry that
 * re-confirms already-stored bytes safely re-enqueues without duplicating
 * the queue entry. If the enqueue call itself fails (this is the only call
 * site that ever enqueues 'artifact_process' — nothing else scans for
 * orphaned stored-but-unprocessed rows), this falls back to processing the
 * artifact inline right here rather than leaving durably-stored bytes with
 * no path to ever being understood. processArtifact's own atomic claim
 * makes that safe even if a delayed retry of the same enqueue also lands.
 */

export interface IngestArtifactInput {
  workspaceId: string
  sourceChannel: string
  bytes: Buffer
  declaredMimeType: string | null
  filename: string | null
  providerAttachmentId: string | null
  conversationId?: string | null
  unifiedMessageId?: string | null
  operatorMessageId?: string | null
  senderContactId?: string | null
  senderOperatorAllowlistId?: number | null
  senderLabel?: string | null
  origin?: 'external' | 'operator_uploaded' | 'customer_uploaded' | 'caye_generated' | 'derived'
  receivedAt?: Date
}

export type IngestArtifactResult =
  | { ok: true; artifact: BusinessArtifactRow; deduped: boolean }
  | { ok: false; error: string; errorCode: 'TOO_LARGE' | 'UPLOAD_FAILED' | 'DB_FAILED' }

async function findExistingRow(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  sourceChannel: string,
  providerAttachmentId: string
): Promise<BusinessArtifactRow | null> {
  const { data } = await supabase
    .from('business_artifacts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('source_channel', sourceChannel)
    .eq('provider_attachment_id', providerAttachmentId)
    .maybeSingle()
  return (data as BusinessArtifactRow | null) ?? null
}

export async function ingestArtifact(input: IngestArtifactInput): Promise<IngestArtifactResult> {
  const supabase = createServiceClient()

  const detectedMimeType = detectMimeType(input.bytes, input.declaredMimeType)
  const modality = modalityFromMimeType(detectedMimeType)
  const limit = CHANNEL_SIZE_LIMITS_BYTES[modality]
  if (input.bytes.byteLength > limit) {
    return {
      ok: false,
      error: `File is ${Math.round(input.bytes.byteLength / 1024 / 1024)}MB, over the ${Math.round(limit / 1024 / 1024)}MB limit for ${modality}.`,
      errorCode: 'TOO_LARGE',
    }
  }

  const contentSha256 = sha256Hex(input.bytes)

  // Resolve the canonical row: reuse an existing one for this provider
  // attachment id (whatever state it's in), or create a fresh one.
  let artifact: BusinessArtifactRow | null = null
  let reused = false

  if (input.providerAttachmentId) {
    artifact = await findExistingRow(supabase, input.workspaceId, input.sourceChannel, input.providerAttachmentId)
    if (artifact) reused = true
  }

  if (!artifact) {
    const { data: inserted, error: insertError } = await supabase
      .from('business_artifacts')
      .insert({
        workspace_id: input.workspaceId,
        origin: input.origin ?? 'external',
        source_channel: input.sourceChannel,
        conversation_id: input.conversationId ?? null,
        unified_message_id: input.unifiedMessageId ?? null,
        operator_message_id: input.operatorMessageId ?? null,
        sender_contact_id: input.senderContactId ?? null,
        sender_operator_allowlist_id: input.senderOperatorAllowlistId ?? null,
        sender_label: input.senderLabel ?? null,
        provider_attachment_id: input.providerAttachmentId,
        filename: input.filename,
        declared_mime_type: input.declaredMimeType,
        detected_mime_type: detectedMimeType,
        byte_size: input.bytes.byteLength,
        content_sha256: contentSha256,
        modality,
        storage_path: 'pending', // placeholder — patched once storage_state becomes 'stored'
        received_at: (input.receivedAt ?? new Date()).toISOString(),
      })
      .select('*')
      .single()

    if (insertError || !inserted) {
      // A concurrent retry racing this same insert hits the unique
      // (workspace_id, source_channel, provider_attachment_id) index —
      // refetch and reuse it, same as the dedup lookup above would have.
      if (insertError?.code === '23505' && input.providerAttachmentId) {
        const raced = await findExistingRow(supabase, input.workspaceId, input.sourceChannel, input.providerAttachmentId)
        if (raced) {
          artifact = raced
          reused = true
        }
      }
      if (!artifact) {
        return { ok: false, error: insertError?.message ?? 'insert failed', errorCode: 'DB_FAILED' }
      }
    } else {
      artifact = inserted as BusinessArtifactRow
    }
  }

  // Bytes already durably confirmed for this row — a genuine no-op replay
  // (webhook retry, duplicate message ingestion, reconnect replay).
  if (artifact.storage_state === 'stored') {
    return { ok: true, artifact, deduped: true }
  }

  // storage_state is 'pending' or 'failed': either this is a brand-new row,
  // or a PRIOR attempt for this same provider attachment never confirmed its
  // bytes (upload failed, or the process crashed between insert and
  // upload). Either way, (re)attempt storing THESE bytes against the SAME
  // canonical row — never a second one.
  const storagePath = buildStoragePath(input.workspaceId, artifact.id, detectedMimeType)
  const uploadResult = await uploadArtifactBytes({ path: storagePath, bytes: input.bytes, mimeType: detectedMimeType })

  if (!uploadResult.ok) {
    await supabase
      .from('business_artifacts')
      .update({
        storage_state: 'failed',
        processing_error: `upload failed: ${uploadResult.error}`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', artifact.id)
    return { ok: false, error: uploadResult.error, errorCode: 'UPLOAD_FAILED' }
  }

  // The blob is now durably in object storage — but the row does not agree
  // until THIS update actually lands. Never assume it landed: if it fails,
  // storage_state stays whatever it was (never falsely 'stored'), so a
  // later retry re-attempts the whole flow. Re-uploading the same bytes is
  // a safe no-op (uploadArtifactBytes treats "already exists" as success),
  // and this time the DB patch gets another chance to actually succeed —
  // this is the self-heal for "upload succeeds, DB state update fails."
  const { data: updated, error: patchError } = await supabase
    .from('business_artifacts')
    .update({
      storage_state: 'stored',
      storage_path: storagePath,
      processing_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', artifact.id)
    .select('*')
    .single()

  if (patchError || !updated) {
    return { ok: false, error: patchError?.message ?? 'failed to record storage state', errorCode: 'DB_FAILED' }
  }
  const stored = updated as BusinessArtifactRow

  // Idempotent: a retry that re-confirms already-attempted bytes re-enqueues
  // safely — the unique idempotency key makes the second enqueue a no-op.
  const enqueueResult = await enqueueOperation({
    workspaceId: input.workspaceId,
    operation: 'artifact_process',
    payload: { artifact_id: stored.id, processing_version: stored.processing_version },
    idempotencyKey: `artifact_process:${stored.id}:v${stored.processing_version}`,
  })

  // Bytes are durably stored regardless of what happens below — that
  // contract is already satisfied. But an enqueue failure here (as opposed
  // to enqueueOperation's normal 23505 "already queued" no-op) would
  // otherwise leave a 'stored' artifact with NO path to ever being
  // understood: nothing re-scans business_artifacts for orphaned rows, and
  // this is the only call site that enqueues 'artifact_process' at all.
  // Fall back to processing it inline, right here, rather than leaving that
  // gap — processArtifact's own atomic claim makes this safe to attempt
  // even if a delayed/retried enqueue also eventually lands.
  if (!enqueueResult.queued) {
    console.error(
      `[ingest] enqueue failed for artifact ${stored.id} (workspace ${input.workspaceId}): ${enqueueResult.reason} — falling back to inline processing`
    )
    try {
      await processArtifact(stored.id)
    } catch (err) {
      console.error(`[ingest] inline processing fallback also failed for artifact ${stored.id}:`, err)
    }
  }

  return { ok: true, artifact: stored, deduped: reused }
}
