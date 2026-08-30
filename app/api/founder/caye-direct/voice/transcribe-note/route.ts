import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'

const MAX_AUDIO_BYTES = 10 * 1024 * 1024
const OPENAI_BASE = 'https://api.openai.com/v1'

export async function POST(request: NextRequest) {
  const founder = await requireFounder(request)
  if (!founder) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'Voice transcription is unavailable' }, { status: 503 })

  const form = await request.formData().catch(() => null)
  const audio = form?.get('audio')
  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: 'Audio is required' }, { status: 400 })
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: 'Voice note is too large' }, { status: 413 })
  }

  const openAiForm = new FormData()
  openAiForm.set('model', process.env.OPENAI_WHATSAPP_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe')
  openAiForm.set('file', audio, audio.name || 'caye-voice-note.webm')
  openAiForm.set('response_format', 'json')

  const response = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: openAiForm,
  })

  if (!response.ok) {
    console.error('[caye-direct] voice-note transcription failed', response.status, (await response.text()).slice(0, 300))
    return NextResponse.json({ error: 'Could not transcribe voice note' }, { status: 502 })
  }

  const json = (await response.json()) as { text?: string }
  const transcript = json.text?.trim()
  if (!transcript) return NextResponse.json({ error: 'No speech detected' }, { status: 422 })

  return NextResponse.json({ transcript })
}
