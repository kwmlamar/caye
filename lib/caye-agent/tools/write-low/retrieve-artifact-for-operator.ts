import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getArtifactDetail } from '@/lib/artifacts/query'
import { signArtifactUrl } from '@/lib/artifacts/storage'
import { isWhatsAppWindowOpen } from '@/lib/whatsapp/window'
import { sendMediaWhatsApp, type WhatsAppMediaType } from '@/lib/whatsapp/outbound'
import { failedPermanent, needsHuman, succeeded } from '../result'
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
 * Returns the ACTUAL original artifact to the operator — the issue's
 * "critical requirement" #5, not a description of it. Classified risk:'low'
 * (a real external send can happen), matching send_operator_message's
 * precedent: operator-directed retrieval of the operator's OWN already-
 * existing data, never a customer-facing send, so no draft/confirm step —
 * same reasoning that keeps schedule_reminder/send_operator_message ungated.
 *
 * CHANNEL-AWARE DELIVERY (multimodal Caye Direct follow-up). The model
 * calls this ONE tool regardless of channel — it never decides transport.
 * ctx.engineeringOrigin's presence is the deterministic signal for "this
 * turn is a founder Caye Direct dashboard turn" (see its doc comment in
 * ../types.ts): when set, this pushes the artifact id onto
 * ctx.businessArtifactIds for inline in-conversation rendering instead of
 * sending WhatsApp media — no operator phone/WhatsApp-window lookup even
 * happens on that path, since nothing is actually sent anywhere. When
 * unset (every WhatsApp operator turn, unchanged), behavior is exactly
 * what it always was.
 */
export const retrieveArtifactForOperator: Tool<RetrieveArtifactForOperatorInput> = {
  name: 'retrieve_artifact_for_operator',
  description:
    'Return the ORIGINAL stored file (image/document/audio/video) to the operator — not a ' +
    'description of it, the actual file. Use when the operator asks to see, get, download, or ' +
    'be sent a specific artifact ("show me that picture", "send me the waiver PDF"). Always ' +
    'resolve the artifact_id via search_artifacts or get_artifact first — never guess one. This ' +
    'only reaches the operator who is asking; it never sends to a customer.\n\n' +
    "The result's `delivery` field tells you what actually happened: 'whatsapp' means a real " +
    "WhatsApp media message was sent — you can say you sent it. 'inline' means this is a Caye " +
    'Direct dashboard turn — the file renders automatically in the conversation right below your ' +
    "reply, nothing was \"sent\" anywhere, so just reference it briefly (e.g. \"Here it is.\") " +
    'rather than claiming you sent or delivered it.',
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

    if (ctx.engineeringOrigin) {
      // Direct channel: no WhatsApp send, no phone/window lookup — the
      // artifact is already durably stored (getArtifactDetail refuses any
      // row whose storage_state isn't 'stored'), which is the only thing
      // that needs to be true for it to render inline. Rendering itself,
      // and the short-lived signed URL it needs, happen later per-request
      // in app/api/founder/business-artifacts/[id]/route.ts — never minted
      // or cached here. ctx.businessArtifactIds dedupes via Set in
      // cayeAgent(), so a repeated call within one turn (recovery retry,
      // or the model calling it twice) never produces two attachment blocks.
      ctx.businessArtifactIds ??= []
      ctx.businessArtifactIds.push(detail.artifact.id)
      return succeeded({
        artifact_id: detail.artifact.id,
        delivery: 'inline',
        filename: detail.artifact.filename,
        modality: detail.artifact.modality,
        source_channel: detail.artifact.source_channel,
        received_at: detail.artifact.received_at,
      })
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
      if (result.blocked) {
        return needsHuman('WHATSAPP_BLOCKED', "That operator's WhatsApp isn't reachable right now — check their number/connection before trying again.")
      }
      if (result.transient) {
        // A network-level failure here does NOT mean the send definitely
        // didn't happen — Meta may have received it before the timeout/
        // reset. Never claim a confident "it failed" (that could prompt an
        // immediate retry and a real duplicate send if it actually went
        // through), and never mark this retryable — a system-level retry
        // is exactly the blind-retry-on-ambiguous-outcome this must avoid.
        // A human deciding to try again, having checked, is fine; an
        // automatic retry loop is not.
        return failedPermanent(
          'SEND_OUTCOME_UNCERTAIN',
          "I couldn't confirm whether that actually sent — the connection dropped before I got a response. Check WhatsApp before asking me to send it again, so we don't risk sending it twice."
        )
      }
      return failedPermanent('SEND_FAILED', `Send failed: ${result.error}`)
    }

    return succeeded({
      artifact_id: detail.artifact.id,
      delivery: 'whatsapp',
      sent: true,
      // Provider evidence for this exact send — not a re-derivable value,
      // the durable trace that THIS message actually went out.
      provider_message_id: result.messageId,
      filename: detail.artifact.filename,
      source_channel: detail.artifact.source_channel,
      received_at: detail.artifact.received_at,
    })
  },
}
