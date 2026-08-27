import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { getArtifactDetail } from './query'
import { downloadArtifactBytes } from './storage'
import type { BusinessArtifactRow } from './types'

/**
 * Caye Direct attachment wiring (#87 follow-up — multimodal Caye Direct).
 *
 * A founder's Caye Direct message can reference business_artifacts the
 * client already uploaded (app/api/founder/caye-direct/attachments/route.ts)
 * BEFORE the send-turn request. The client only ever supplies artifact ids —
 * never a storage path — so every id must be re-resolved against THIS
 * workspace here; an id from another workspace, or one that never existed,
 * resolves to nothing (getArtifactDetail is already workspace-scoped and
 * refuses any row whose storage_state isn't 'stored' — see query.ts).
 */

export type ResolvedAttachment = { artifact: BusinessArtifactRow }

export interface ResolveAttachmentsResult {
  resolved: ResolvedAttachment[]
  /** ids that did not resolve to a stored artifact in this workspace — forged, foreign-workspace, or not-yet-stored ids. */
  invalidIds: string[]
}

/** Re-verifies every client-supplied id belongs to this workspace and has durable bytes. Never trusts the id alone. */
export async function resolveWorkspaceAttachments(
  workspaceId: string,
  artifactIds: readonly string[]
): Promise<ResolveAttachmentsResult> {
  const ids = [...new Set(artifactIds)]
  const resolved: ResolvedAttachment[] = []
  const invalidIds: string[] = []
  for (const id of ids) {
    const detail = await getArtifactDetail(workspaceId, id)
    if (!detail || detail.artifact.retention_status !== 'active') {
      invalidIds.push(id)
      continue
    }
    resolved.push({ artifact: detail.artifact })
  }
  return { resolved, invalidIds }
}

const INLINE_IMAGE_MIME: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/**
 * Builds the SAME shape of Anthropic content blocks the WhatsApp operator
 * webhook's handleImageInbound/handleDocumentInbound already send inline for
 * a live vision/document read on the turn the file arrives — see that
 * file's header comment. Bytes are read once here and never persisted
 * outside business_artifacts; the model sees them for this turn only.
 * Modalities with no inline reading path (audio/video/spreadsheet/other,
 * or an image mime type the vision API doesn't accept) still get the file
 * durably stored — this only controls whether THIS turn can read it live.
 */
export async function buildAttachmentContentBlocks(
  attachments: readonly ResolvedAttachment[]
): Promise<{ blocks: Exclude<Anthropic.MessageParam['content'], string>; unreadableNote: string | null }> {
  const blocks: Exclude<Anthropic.MessageParam['content'], string> = []
  const unreadable: string[] = []

  for (const { artifact } of attachments) {
    const mimeType = artifact.detected_mime_type ?? artifact.declared_mime_type ?? ''
    if (artifact.modality === 'image' && INLINE_IMAGE_MIME.has(mimeType)) {
      const bytes = await downloadArtifactBytes(artifact.storage_path)
      if (!bytes) {
        unreadable.push(artifact.filename ?? 'an attached image')
        continue
      }
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: bytes.toString('base64') },
      })
    } else if (artifact.modality === 'document' && mimeType === 'application/pdf') {
      const bytes = await downloadArtifactBytes(artifact.storage_path)
      if (!bytes) {
        unreadable.push(artifact.filename ?? 'an attached document')
        continue
      }
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') },
      })
    }
    // Everything else (non-PDF documents, audio/video/spreadsheet/other):
    // durably stored (caller already confirmed storage_state='stored' via
    // resolveWorkspaceAttachments) but not read inline this turn — same
    // "unsupported for live reading" boundary the WhatsApp document handler
    // already draws. Async understanding (processArtifact) still runs.
  }

  // No `[${...}]`-shaped wrapping here on purpose — see
  // lib/no-internal-leak-paths.test.ts. This is plain sentence text handed
  // to the model as part of the turn, not an internal marker.
  const unreadableNote = unreadable.length
    ? `Saved but could not be read live this turn (still stored, try again in a moment): ${unreadable.join(', ')}.`
    : null

  return { blocks, unreadableNote }
}
