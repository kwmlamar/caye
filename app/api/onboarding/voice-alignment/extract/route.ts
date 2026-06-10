import { NextRequest, NextResponse } from 'next/server'
import { extractVoiceProfile } from '@/lib/voice-profile'
import { fetchOwnerMessageSamples } from '@/lib/owner-voice-learning'

/**
 * POST /api/onboarding/voice-alignment/extract
 *
 * Pulls the workspace owner's last ~30 sent emails, runs voice extraction,
 * returns the profile without persisting. The dashboard "Get aligned with Caye"
 * card uses this to show the owner what Caye picked up — they edit/confirm in
 * the modal, then the confirm endpoint writes it.
 */
export async function POST(req: NextRequest) {
  try {
    const { workspaceId } = (await req.json()) as { workspaceId: string }

    if (!workspaceId) {
      return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 })
    }

    const samples = await fetchOwnerMessageSamples(workspaceId)
    if (samples.length < 3) {
      return NextResponse.json(
        {
          error: 'not_enough_samples',
          message:
            'Caye needs at least 3 sent messages from you to pick up your voice. Send a few replies first and try again.',
          sample_count: samples.length,
        },
        { status: 422 }
      )
    }

    const voiceProfile = await extractVoiceProfile(samples)
    return NextResponse.json({ voiceProfile, sample_count: samples.length })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected error'
    console.error('[voice-alignment/extract]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
