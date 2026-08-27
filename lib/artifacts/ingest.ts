import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { enqueueOperation } from '@/lib/pending-operations'
import {
  buildStoragePath,
  detectMimeType,
  sha256Hex,
  uploadArtifactBytes,
} from './storage'
import { CHANNEL_SIZE_LIMITS_BYTES, modalityFromMimeType, type BusinessArtifactRow } from './types'

/**
 * Ingestion entry point for a durable business artifact (#87).
 *
 * Called synchronously from a channel's inbound handler (e.g. the WhatsApp
 * operator webhook's image/document branch) BEFORE the model ever sees the
 * bytes. Idempotent: the same provider attachment delivered twice (webhook
 * retry, duplicate message ingestion, reconnect replay) returns the SAME
 * artifact row rather than creating a second one.
 *
 * Always enqueues an `artifact_process` job. Callers that also want an
 * immediate inline understanding pass (for conversational responsiveness)
 * call `processArtifact` themselves right after — it is idempotent per
 * processing_version, so the queue draining it later (retry path, or the
 * primary path for channels with no inline pass) never double-processes.
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
  origin?: 'external' | 'operator_uploaded' | 'customer_uploaded'
  receivedAt?: Date
}

export type IngestArtifactResult =
  | { ok: true; artifact: BusinessArtifactRow; deduped: boolean }
  | { ok: false; error: string; errorCode: 'TOO_LARGE' | 'UPLOAD_FAILED' | 'DB_FAILED' }

export async function ingestArtifact(input: IngestArtifactInput): Promise<IngestArtifactResult> {
  const supabase = createServiceClient()

  // Idempotent retry key: the same provider attachment already ingested for
  // this workspace/channel is the same promise, not a new artifact.
  if (input.providerAttachmentId) {
    const { data: existing } = await supabase
      .from('business_artifacts')
      .select('*')
      .eq('workspace_id', input.workspaceId)
      .eq('source_channel', input.sourceChannel)
      .eq('provider_attachment_id', input.providerAttachmentId)
      .maybeSingle()
    if (existing) {
      return { ok: true, artifact: existing as BusinessArtifactRow, deduped: true }
    }
  }

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

  // Insert first (artifact id is the storage path's directory), then upload.
  // A row with no bytes yet (processing_status stays 'pending' either way)
  // is recoverable; bytes with no row is an orphan with nothing pointing at
  // it. Ingestion always enqueues processing regardless, so a failed upload
  // surfaces as a failed processing attempt rather than a silent gap.
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
      storage_path: 'pending', // placeholder, patched below once we have the real id
      received_at: (input.receivedAt ?? new Date()).toISOString(),
    })
    .select('*')
    .single()

  if (insertError || !inserted) {
    // A concurrent retry racing this same insert hits the unique
    // (workspace_id, source_channel, provider_attachment_id) index — refetch
    // and treat it as the dedup path rather than a failure.
    if (insertError?.code === '23505' && input.providerAttachmentId) {
      const { data: raced } = await supabase
        .from('business_artifacts')
        .select('*')
        .eq('workspace_id', input.workspaceId)
        .eq('source_channel', input.sourceChannel)
        .eq('provider_attachment_id', input.providerAttachmentId)
        .maybeSingle()
      if (raced) return { ok: true, artifact: raced as BusinessArtifactRow, deduped: true }
    }
    return { ok: false, error: insertError?.message ?? 'insert failed', errorCode: 'DB_FAILED' }
  }

  const artifact = inserted as BusinessArtifactRow
  const storagePath = buildStoragePath(input.workspaceId, artifact.id, detectedMimeType)

  const uploadResult = await uploadArtifactBytes({ path: storagePath, bytes: input.bytes, mimeType: detectedMimeType })
  if (!uploadResult.ok) {
    await supabase
      .from('business_artifacts')
      .update({ processing_status: 'failed', processing_error: `upload failed: ${uploadResult.error}` })
      .eq('id', artifact.id)
    return { ok: false, error: uploadResult.error, errorCode: 'UPLOAD_FAILED' }
  }

  await supabase.from('business_artifacts').update({ storage_path: storagePath }).eq('id', artifact.id)
  artifact.storage_path = storagePath

  await enqueueOperation({
    workspaceId: input.workspaceId,
    operation: 'artifact_process',
    payload: { artifact_id: artifact.id, processing_version: artifact.processing_version },
    idempotencyKey: `artifact_process:${artifact.id}:v${artifact.processing_version}`,
  })

  return { ok: true, artifact, deduped: false }
}
