import { NextRequest, NextResponse } from 'next/server'
import { extractVoiceProfile } from '@/lib/voice-profile'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { samples: string[]; workspaceId: string }
    const { samples, workspaceId } = body

    if (!workspaceId || !samples?.length) {
      return NextResponse.json({ error: 'Missing samples or workspaceId' }, { status: 400 })
    }

    // Join and split on --- to normalize however many strings arrive
    const splitSamples = samples
      .join('\n---\n')
      .split(/\n?---\n?/)
      .map(s => s.trim())
      .filter(Boolean)

    if (!splitSamples.length) {
      return NextResponse.json({ error: 'No valid samples provided' }, { status: 400 })
    }

    const voiceProfile = await extractVoiceProfile(splitSamples)
    return NextResponse.json({ voiceProfile })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected error'
    console.error('[onboarding/voice-sample]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
