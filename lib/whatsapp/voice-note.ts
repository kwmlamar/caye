import 'server-only'
import { downloadWhatsAppMediaWithToken } from './media'

const OPENAI_BASE = 'https://api.openai.com/v1'
const GRAPH_VERSION = process.env.META_API_VERSION || 'v21.0'

function openAiKey(): string {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('Missing OPENAI_API_KEY for WhatsApp voice notes')
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
  const bytes = Buffer.from(media.base64, 'base64')
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
    throw new Error(
      `OpenAI voice-note transcription failed: ${res.status} ${(await res.text()).slice(0, 400)}`
    )
  }
  const json = (await res.json()) as { text?: string }
  const transcript = json.text?.trim()
  if (!transcript) throw new Error('OpenAI returned an empty voice-note transcript')
  return { transcript, mimeType: media.mimeType }
}

export async function synthesizeWhatsAppVoiceNote(text: string): Promise<Uint8Array> {
  const res = await fetch(`${OPENAI_BASE}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openAiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_WHATSAPP_TTS_MODEL || 'gpt-4o-mini-tts',
      voice: process.env.OPENAI_WHATSAPP_TTS_VOICE || 'coral',
      input: text,
      response_format: 'opus',
      instructions:
        'Speak naturally and conversationally as Caye. Keep the delivery concise, warm, and unhurried.',
    }),
  })
  if (!res.ok) {
    throw new Error(
      `OpenAI voice-note synthesis failed: ${res.status} ${(await res.text()).slice(0, 400)}`
    )
  }
  return new Uint8Array(await res.arrayBuffer())
}

export async function uploadWhatsAppAudio(
  audio: Uint8Array,
  phoneNumberId: string,
  accessToken: string
): Promise<string> {
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', 'audio/ogg')
  form.append('file', new Blob([exactArrayBuffer(audio)], { type: 'audio/ogg' }), 'caye.ogg')

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  })
  if (!res.ok) {
    throw new Error(
      `WhatsApp audio upload failed: ${res.status} ${(await res.text()).slice(0, 400)}`
    )
  }
  const json = (await res.json()) as { id?: string }
  if (!json.id) throw new Error('WhatsApp audio upload returned no media id')
  return json.id
}

export async function sendWhatsAppVoiceNote(
  to: string,
  text: string,
  phoneNumberId: string,
  accessToken: string
): Promise<void> {
  const audio = await synthesizeWhatsAppVoiceNote(text)
  const mediaId = await uploadWhatsAppAudio(audio, phoneNumberId, accessToken)
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'audio',
      audio: { id: mediaId },
    }),
  })
  if (!res.ok) {
    throw new Error(
      `WhatsApp voice-note send failed: ${res.status} ${(await res.text()).slice(0, 400)}`
    )
  }
}
