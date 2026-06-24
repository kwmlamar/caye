import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { extractVoiceProfile } from '@/lib/voice-profile'
import { fetchOwnerMessageSamples } from '@/lib/owner-voice-learning'
import type { Tool } from '../types'

interface AddVoiceSampleInput {
  text: string
  label?: string
}

interface ManualSample {
  text: string
  label?: string
  added_at: string
}

export const addVoiceSample: Tool<AddVoiceSampleInput> = {
  name: 'add_voice_sample',
  description:
    "Add a writing sample so Caye learns the owner's voice from it. Use when the owner pastes " +
    "an email or message and says \"here's how I'd reply\" or \"this is the tone I want\".\n\n" +
    "Re-runs the voice extractor immediately (does NOT wait for the scheduled batch). The new " +
    "profile takes effect on the next customer reply. Per-sample latency: a few seconds while " +
    "the extractor runs — fine to acknowledge \"got it, learning your voice now\" and let the " +
    "owner continue.\n\n" +
    "Manual samples are merged with the most-recent inbox-derived samples; old manual samples " +
    "stay in the pool unless the owner explicitly asks to clear them.",
  risk: 'low',
  roles: ['owner', 'founder'],
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The writing sample. Should be at least one paragraph.' },
      label: { type: 'string', description: 'Optional short label ("formal email", "casual reply").' },
    },
    required: ['text'],
  },

  async execute(args, ctx) {
    const text = args.text.trim()
    if (text.length < 30) {
      return { ok: false, error: 'Sample is too short — paste at least a paragraph.' }
    }
    if (text.length > 8000) {
      return { ok: false, error: 'Sample is too long — trim to under 8000 characters.' }
    }

    const supabase = createServiceClient()
    const { data: customer } = await supabase
      .from('customers')
      .select('manual_voice_samples')
      .eq('id', ctx.workspaceId)
      .maybeSingle()

    const current = (customer?.manual_voice_samples as ManualSample[] | null) ?? []
    const sample: ManualSample = {
      text,
      ...(args.label?.trim() ? { label: args.label.trim() } : {}),
      added_at: new Date().toISOString(),
    }
    // Cap stored manual samples at 20 — older ones rotate off so the
    // extractor sees the owner's current voice, not their voice from a year ago.
    const next = [...current, sample].slice(-20)

    const { error: writeErr } = await supabase
      .from('customers')
      .update({ manual_voice_samples: next })
      .eq('id', ctx.workspaceId)
    if (writeErr) return { ok: false, error: writeErr.message }

    // Immediate re-train. Merge manual samples with inbox-derived ones so
    // the extractor sees both. Failure is non-fatal — the manual sample is
    // already persisted and will be picked up on the next scheduled refresh.
    let reTrained = false
    let reTrainError: string | null = null
    try {
      const inboxSamples = await fetchOwnerMessageSamples(ctx.workspaceId)
      const allSamples = [...next.map((s) => s.text), ...inboxSamples].slice(0, 40)
      if (allSamples.length >= 3) {
        const profile = await extractVoiceProfile(allSamples)
        await supabase
          .from('customers')
          .update({
            ai_voice_profile: profile,
            voice_profile_updated_at: new Date().toISOString(),
            owner_messages_since_profile_update: 0,
          })
          .eq('id', ctx.workspaceId)
        reTrained = true
      }
    } catch (err) {
      reTrainError = err instanceof Error ? err.message : String(err)
      console.error('[add-voice-sample] re-train failed:', err)
    }

    return {
      ok: true,
      data: {
        sample_count: next.length,
        retrained: reTrained,
        retrain_error: reTrainError,
      },
    }
  },
}
