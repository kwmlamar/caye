import 'server-only'
import { transcribeWhatsAppVoiceNote } from './voice-note'

export interface WhatsAppInboundAudio {
  id: string
  mime_type?: string
  voice?: boolean
}

export interface ResolvedWhatsAppVoiceInput {
  body: string
  mediaId: string
  mimeType: string | null
}

/**
 * Shared semantic conversion for customer/operator webhooks. It deliberately
 * does not choose an agent or workspace. Callers resolve identity/authority
 * first, then feed the resulting transcript into their existing text path.
 */
export async function resolveWhatsAppVoiceInput(
  audio: WhatsAppInboundAudio,
  accessToken: string
): Promise<ResolvedWhatsAppVoiceInput> {
  const result = await transcribeWhatsAppVoiceNote(audio.id, accessToken)
  return {
    body: result.transcript,
    mediaId: audio.id,
    mimeType: result.mimeType || audio.mime_type || null,
  }
}
