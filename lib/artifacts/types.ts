/**
 * Shared types for the multimodal Business Memory artifact system (#87).
 *
 * Mirrors the check constraints in
 * supabase/migrations/20260826g_business_artifacts.sql. Closed-world states
 * (origin, modality, processing_status, retention_status, provenance_status,
 * relation status/provenance) are typed unions here; open-ended vocabularies
 * (source_channel, relation_type, target_entity_type) stay `string` on
 * purpose — see the migration header for why.
 */

export type ArtifactOrigin =
  | 'external'
  | 'operator_uploaded'
  | 'customer_uploaded'
  | 'caye_generated'
  | 'derived'

export type ArtifactModality = 'image' | 'document' | 'audio' | 'video' | 'spreadsheet' | 'other'

export type ArtifactProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'unsupported'

/**
 * Durability of the original bytes — INDEPENDENT of processing_status.
 * A row can exist ('pending' — just inserted, or a prior attempt never
 * confirmed) without its bytes ever having been stored ('failed' — the
 * upload itself failed, or the process crashed before it ran). Only
 * 'stored' means the blob is confirmed durable and safe to process/return.
 * See lib/artifacts/ingest.ts's header comment for the full state model.
 */
export type ArtifactStorageState = 'pending' | 'stored' | 'failed'

export type ArtifactRetentionStatus = 'active' | 'tombstoned' | 'deleted'

export type ObservationType =
  | 'visual_description'
  | 'visible_text'
  | 'document_extraction'
  | 'summary'
  | 'entity_observation'
  | 'operator_annotation'
  | 'transcript'
  | 'spreadsheet_schema'
  | 'other'

export type ProvenanceStatus = 'extracted' | 'observed' | 'inferred' | 'operator_confirmed' | 'superseded'

export type RelationStatus = 'candidate' | 'confirmed' | 'corrected' | 'rejected'

export type RelationProvenance = 'model_inferred' | 'operator_confirmed' | 'operator_corrected' | 'system_derived'

/** Known source_channel values in use today. New channels don't require a migration — see the table comment. */
export type KnownSourceChannel =
  | 'whatsapp_operator'
  | 'whatsapp_frontdesk'
  | 'email_zoho'
  | 'email_gmail'
  | 'instagram'
  | 'messenger'
  | 'dashboard'

export interface BusinessArtifactRow {
  id: string
  workspace_id: string
  origin: ArtifactOrigin
  source_channel: string
  conversation_id: string | null
  unified_message_id: string | null
  operator_message_id: string | null
  sender_contact_id: string | null
  sender_operator_allowlist_id: number | null
  sender_label: string | null
  provider_attachment_id: string | null
  filename: string | null
  declared_mime_type: string | null
  detected_mime_type: string | null
  byte_size: number | null
  content_sha256: string
  modality: ArtifactModality
  storage_bucket: string
  storage_path: string
  storage_state: ArtifactStorageState
  received_at: string
  processing_status: ArtifactProcessingStatus
  processing_version: number
  processing_error: string | null
  processing_completed_at: string | null
  processing_claim_token: string | null
  processing_claimed_at: string | null
  retention_status: ArtifactRetentionStatus
  tombstoned_at: string | null
  tombstoned_reason: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export interface BusinessArtifactObservationRow {
  id: string
  artifact_id: string
  workspace_id: string
  observation_type: ObservationType
  modality: string | null
  content: Record<string, unknown>
  confidence: number | null
  provenance_status: ProvenanceStatus
  derived_by: string
  model_version: string | null
  superseded_by: string | null
  superseded_at: string | null
  created_at: string
}

export interface BusinessArtifactRelationRow {
  id: string
  workspace_id: string
  artifact_id: string
  relation_type: string
  target_entity_type: string
  target_entity_id: string
  label: string | null
  status: RelationStatus
  confidence: number | null
  provenance: RelationProvenance
  source_observation_id: string | null
  confirmed_by_operator_allowlist_id: number | null
  confirmed_at: string | null
  corrected_from_relation_id: string | null
  superseded_at: string | null
  created_at: string
}

/** Per-channel size ceilings, deliberately tighter than the bucket-level cap. */
export const CHANNEL_SIZE_LIMITS_BYTES: Record<ArtifactModality, number> = {
  image: 5 * 1024 * 1024, // WhatsApp image cap
  document: 100 * 1024 * 1024, // WhatsApp document cap
  audio: 16 * 1024 * 1024, // WhatsApp audio cap
  video: 16 * 1024 * 1024, // WhatsApp video cap
  spreadsheet: 100 * 1024 * 1024,
  other: 16 * 1024 * 1024,
}

export function modalityFromMimeType(mimeType: string): ArtifactModality {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  if (
    mimeType === 'text/csv' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel'
  ) {
    return 'spreadsheet'
  }
  if (
    mimeType === 'application/pdf' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword'
  ) {
    return 'document'
  }
  return 'other'
}
