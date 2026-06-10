import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import type { VoiceProfile } from '@/lib/voice-profile'

/**
 * POST /api/onboarding/voice-alignment/confirm
 *
 * Accepts the (possibly edited) profile from the dashboard alignment modal,
 * writes it to customers.ai_voice_profile, and stamps
 * voice_alignment_confirmed_at so the card hides going forward.
 */
export async function POST(req: NextRequest) {
  try {
    const { workspaceId, voiceProfile } = (await req.json()) as {
      workspaceId: string
      voiceProfile: VoiceProfile
    }

    if (!workspaceId || !voiceProfile) {
      return NextResponse.json(
        { error: 'Missing workspaceId or voiceProfile' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()
    const nowISO = new Date().toISOString()
    const { error } = await supabase
      .from('customers')
      .update({
        ai_voice_profile: voiceProfile,
        voice_profile_updated_at: nowISO,
        voice_alignment_confirmed_at: nowISO,
        owner_messages_since_profile_update: 0,
      })
      .eq('id', workspaceId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true, confirmed_at: nowISO })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected error'
    console.error('[voice-alignment/confirm]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
