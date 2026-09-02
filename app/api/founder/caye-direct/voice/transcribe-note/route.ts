import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { OpenAiAudioRequestError, OpenAiAudioUnavailableError, transcribeOpenAiAudio } from '@/lib/ai/providers/openai-audio'

const MAX_AUDIO_BYTES = 10 * 1024 * 1024

export async function POST(request: NextRequest) {
  const founder = await requireFounder(request)
  if (!founder) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const form = await request.formData().catch(() => null)
  const audio = form?.get('audio')
  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: 'Audio is required' }, { status: 400 })
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json({ error: 'Voice note is too large' }, { status: 413 })
  }

  let transcript: string
  try {
    transcript = await transcribeOpenAiAudio(audio)
  } catch (error) {
    if (error instanceof OpenAiAudioUnavailableError) {
      return NextResponse.json({ error: 'Voice transcription is unavailable' }, { status: 503 })
    }
    if (error instanceof OpenAiAudioRequestError) {
      console.error('[caye-direct] voice-note transcription failed', error.status, error.message)
      return NextResponse.json({ error: 'Could not transcribe voice note' }, { status: 502 })
    }
    throw error
  }
  if (!transcript) return NextResponse.json({ error: 'No speech detected' }, { status: 422 })

  return NextResponse.json({ transcript })
}
