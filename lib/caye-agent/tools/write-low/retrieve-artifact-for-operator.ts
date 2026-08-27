import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getArtifactDetail } from '@/lib/artifacts/query'
import { signArtifactUrl } from '@/lib/artifacts/storage'
import { isWhatsAppWindowOpen } from '@/lib/whatsapp/window'
import { sendMediaWhatsApp, type WhatsAppMediaType } from '@/lib/whatsapp/outbound'
import type { Tool } from '../types'

interface RetrieveArtifactForOperatorInput {
  artifact_id: string
}

const SENDABLE_MODALITY: Record<string, WhatsAppMediaType | undefined> = {
  image: 'image',
  document: 'document',
  audio: 'audio',
  video: 'video',
}

/**
 * Returns the ACTUAL original artifact to the operator over WhatsApp — the
 * issue's "critical requirement" #5, not a description of it. Classified
 * risk:'low' (a real external send happens), matching send_operator_message's
 * precedent: operator-directed retrieval of the operator's OWN already-
 * existing data, never a customer-facing send, so no draft/confirm step —
 * same reasoning that keeps schedule_reminder/send_operator_message ungated.
 */
export const retrieveArtifactForOperator: Tool<RetrieveArtifactForOperatorInput> = {
  name: 'retrieve_artifact_for_operator',
  description:
    'Send the ORIGINAL stored file (image/document/audio/video) back to the operator over ' +
    'WhatsApp — not a description of it, the actual file. Use when the operator asks to see, ' +
    'get, download, or be sent a specific artifact ("show me that picture", "send me the ' +
    'waiver PDF"). Always resolve the artifact_id via search_artifacts or get_artifact first — ' +
    'never guess one. This only reaches the operator who is asking; it never sends to a customer.',
  risk: 'low',
  roles: ['owner', 'staff', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      artifact_id: { type: 'string', description: 'The business_artifacts.id to send.' },
    },
    required: ['artifact_id'],
  },
  async execute(args, ctx) {
    const detail = await getArtifactDetail(ctx.workspaceId, args.artifact_id)
    if (!detail) return { ok: false, error: 'No artifact found with that id in this workspace.' }
    if (detail.artifact.retention_status !== 'active') {
      return { ok: false, error: `That artifact is ${detail.artifact.retention_status} and no longer retrievable.` }
    }

    const mediaType = SENDABLE_MODALITY[detail.artifact.modality]
    if (!mediaType) {
      return { ok: false, error: `Can't send a ${detail.artifact.modality} file over WhatsApp yet.` }
    }
    if (!ctx.operatorId) return { ok: false, error: 'No operator identity on this request.' }
    const supabase = createServiceClient()
    const { data: operator } = await supabase
      .from('operator_allowlist')
      .select('id, phone')
      .eq('id', ctx.operatorId)
      .maybeSingle()
    if (!operator?.phone) return { ok: false, error: 'Could not resolve a phone number to send to.' }

    const windowOpen = await isWhatsAppWindowOpen(ctx.workspaceId, operator.phone)
    if (!windowOpen) {
      return { ok: false, error: "Can't send media right now — message me something first to reopen the window, then ask again." }
    }

    const signedUrl = await signArtifactUrl(detail.artifact.storage_path)
    if (!signedUrl) return { ok: false, error: 'Could not prepare that file for sending — try again.' }

    const caption = detail.artifact.filename ?? undefined
    const result = await sendMediaWhatsApp(
      operator.phone,
      mediaType,
      signedUrl,
      caption ?? null,
      `retrieve-artifact-${detail.artifact.id}-${ctx.requestId}`
    )

    if (result.status === 'failed') {
      return { ok: false, error: `Send failed: ${result.error}` }
    }

    return {
      ok: true,
      data: {
        artifact_id: detail.artifact.id,
        sent: true,
        filename: detail.artifact.filename,
        source_channel: detail.artifact.source_channel,
        received_at: detail.artifact.received_at,
      },
    }
  },
}
