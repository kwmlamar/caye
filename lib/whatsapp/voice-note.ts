import 'server-only'
import { downloadWhatsAppMediaWithToken } from './media'

const OPENAI_BASE = 'https://api.openai.com/v1'

function openAiKey(): string {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('Missing OPENAI_API_KEY for WhatsApp voice-note transcription')
  return key
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes('ogg') || mimeType.includes('opus')) return 'ogg'
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a'
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('webm')) return 'webm'
  return 'audio'
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export async function transcribeWhatsAppVoiceNote(
  mediaId: string,
  accessToken: string
): Promise<{ transcript: string; mimeType: string }> {
  const media = await downloadWhatsAppMediaWithToken(mediaId, accessToken)
  if (!media.mimeType.startsWith('audio/')) {
    throw new Error(`WhatsApp media is not audio: ${media.mimeType}`)
  }

  const bytes = Buffer.from(media.base64, 'base64')
  if (bytes.byteLength === 0) throw new Error('WhatsApp voice note was empty')

  const form = new FormData()
  form.append('model', process.env.OPENAI_WHATSAPP_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe')
  form.append(
    'file',
    new Blob([exactArrayBuffer(bytes)], { type: media.mimeType }),
    `whatsapp-voice.${extensionForMime(media.mimeType)}`
  )
  form.append('response_format', 'json')

  const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${openAiKey()}` },
    body: form,
  })
  if (!res.ok) {
    throw new Error(`OpenAI voice-note transcription failed: ${res.status} ${(await res.text()).slice(0, 400)}`)
  }

  const json = (await res.json()) as { text?: string }
  const transcript = json.text?.trim()
  if (!transcript) throw new Error('OpenAI returned an empty voice-note transcript')
  return { transcript, mimeType: media.mimeType }
}
