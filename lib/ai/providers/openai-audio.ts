import 'server-only'

/** OpenAI audio transport kept behind the Caye AI provider-adapter boundary. */
const OPENAI_BASE_URL = 'https://api.openai.com/v1'

export async function transcribeOpenAiAudio(audio: File): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new OpenAiAudioUnavailableError()

  const form = new FormData()
  form.set('model', process.env.OPENAI_WHATSAPP_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe')
  form.set('file', audio, audio.name || 'caye-voice-note.webm')
  form.set('response_format', 'json')

  const response = await fetch(`${OPENAI_BASE_URL}/audio/transcriptions`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    throw new OpenAiAudioRequestError(response.status, detail)
  }

  const json = await response.json() as { text?: string }
  return json.text?.trim() ?? ''
}

export class OpenAiAudioUnavailableError extends Error {
  constructor() {
    super('OpenAI audio transcription is not configured')
    this.name = 'OpenAiAudioUnavailableError'
  }
}

export class OpenAiAudioRequestError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`OpenAI audio transcription failed (${status})${detail ? `: ${detail}` : ''}`)
    this.name = 'OpenAiAudioRequestError'
  }
}
