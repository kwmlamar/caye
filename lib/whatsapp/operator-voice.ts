import 'server-only'

import { transcribeWhatsAppVoiceNote, sendWhatsAppVoiceNote } from './voice-note'

export interface OperatorVoiceAudio {
  id: string
  mime_type?: string
  voice?: boolean
}

export interface OperatorVoiceInbound {
  id: string
  type: string
  text?: { body: string }
  audio?: OperatorVoiceAudio
}

export interface OperatorVoiceSemanticInput {
  body: string
  inboundWasVoice: boolean
  mediaId?: string
  mimeType?: string
  voice?: boolean
}

/**
 * Convert a verified operator/founder WhatsApp audio message into the same
 * semantic text input used by the existing operator pipeline.
 *
 * IMPORTANT: callers must resolve and verify operator identity/workspace
 * authority before invoking this function. Audio is a transport, never a
 * shortcut around the operator allowlist or approval boundary.
 */
export async function resolveVerifiedOperatorVoiceInput(
  message: OperatorVoiceInbound,
  accessToken: string
): Promise<OperatorVoiceSemanticInput | null> {
  if (message.type === 'text' && message.text?.body?.trim()) {
    return { body: message.text.body.trim(), inboundWasVoice: false }
  }

  if (message.type !== 'audio' || !message.audio?.id) return null

  const transcription = await transcribeWhatsAppVoiceNote(message.audio.id, accessToken)
  return {
    body: transcription.transcript,
    inboundWasVoice: true,
    mediaId: message.audio.id,
    mimeType: transcription.mimeType || message.audio.mime_type,
    voice: message.audio.voice,
  }
}

/**
 * Render an already-authorized operator reply as WhatsApp audio. Failure is
 * intentionally surfaced so the webhook can reuse the exact same text via
 * its normal send helper without executing Caye a second time.
 */
export async function sendVerifiedOperatorVoiceReply(args: {
  to: string
  text: string
  phoneNumberId: string
  accessToken: string
}): Promise<void> {
  await sendWhatsAppVoiceNote(args.to, args.text, args.phoneNumberId, args.accessToken)
}
