import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { extractVoiceProfile } from '@/lib/voice-profile'
import {
  TRUSTED_VOICE_CHANNELS,
  REFRESH_EVERY,
  isTrustedVoiceChannel,
  shouldRefreshOwnerVoiceProfile,
} from '@/lib/owner-voice-trigger'

/**
 * How many of the owner's most recent outbound messages to feed Claude
 * when re-extracting the voice profile. Bigger sample = more stable
 * profile, more API tokens. 30 is enough to span tone variation without
 * being noisy.
 */
const SAMPLE_SIZE = 30

/**
 * Fire-and-forget hook called after the owner sends a manual reply.
 *
 * Increments owner_messages_since_profile_update on the workspace; when
 * the counter hits REFRESH_EVERY, pulls the owner's latest outbound
 * messages from trusted channels and re-runs extractVoiceProfile() in
 * the background. On success, stores the new profile, stamps
 * voice_profile_updated_at, and resets the counter.
 *
 * Safe to .catch() at the caller — any failure is logged but never
 * surfaced because voice learning is non-critical to reply correctness.
 *
 * @param workspaceId - The customers.id (workspace owner ID)
 * @param channel - The channel of the message just sent; only counted
 *   when it's in TRUSTED_CHANNELS so test data doesn't trigger refreshes.
 */
export async function maybeRefreshOwnerVoiceProfile(
  workspaceId: string,
  channel: string
): Promise<void> {
  if (!isTrustedVoiceChannel(channel)) {
    return
  }

  const supabase = createServiceClient()

  const { data: current, error: readErr } = await supabase
    .from('customers')
    .select('owner_messages_since_profile_update')
    .eq('id', workspaceId)
    .maybeSingle()

  if (readErr || !current) {
    console.warn(`[owner-voice] Could not read workspace ${workspaceId}:`, readErr?.message)
    return
  }

  const newCount = (current.owner_messages_since_profile_update ?? 0) + 1

  if (!shouldRefreshOwnerVoiceProfile(newCount)) {
    await supabase
      .from('customers')
      .update({ owner_messages_since_profile_update: newCount })
      .eq('id', workspaceId)
    return
  }

  // Hit the threshold — pull samples and re-extract. We do this BEFORE
  // resetting the counter so a failure preserves progress (next message
  // will retry rather than silently waiting another 10 messages).
  const samples = await fetchOwnerMessageSamples(workspaceId)
  if (samples.length < 3) {
    console.log(
      `[owner-voice] Workspace ${workspaceId} hit threshold but only ${samples.length} ` +
        'samples available — skipping re-extraction.'
    )
    return
  }

  try {
    const profile = await extractVoiceProfile(samples)
    const nowISO = new Date().toISOString()
    await supabase
      .from('customers')
      .update({
        ai_voice_profile: profile,
        voice_profile_updated_at: nowISO,
        owner_messages_since_profile_update: 0,
      })
      .eq('id', workspaceId)
    console.log(
      `[owner-voice] Refreshed voice profile for workspace ${workspaceId} ` +
        `(samples=${samples.length}, formality=${profile.formality_level})`
    )
  } catch (err) {
    console.error(`[owner-voice] Extraction failed for workspace ${workspaceId}:`, err)
    // Don't reset the counter — leave it at REFRESH_EVERY so the next send
    // will retry. (Acceptable: at worst we re-attempt on the next owner reply.)
  }
}

/**
 * Pull the workspace owner's most recent manual outbound message bodies
 * for use as voice samples. Filters:
 * - Trusted channels only (avoid test-data pollution)
 * - sender_type = 'business' (outbound)
 * - metadata.sent_by = 'human' (excludes Caye auto-replies)
 * - non-internal (excludes hold-for-human notes)
 */
export async function fetchOwnerMessageSamples(workspaceId: string): Promise<string[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('unified_messages')
    .select(`
      content,
      metadata,
      unified_conversations!inner(
        channel_type,
        connected_accounts!inner(user_id)
      )
    `)
    .eq('sender_type', 'business')
    .eq('is_internal', false)
    .eq('unified_conversations.connected_accounts.user_id', workspaceId)
    .in('unified_conversations.channel_type', TRUSTED_VOICE_CHANNELS as readonly string[])
    .order('sent_at', { ascending: false })
    .limit(SAMPLE_SIZE * 3) // overfetch to allow filtering out non-human messages

  if (error || !data) {
    console.warn('[owner-voice] Sample fetch failed:', error?.message)
    return []
  }

  return data
    .filter(row => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>
      // Owner messages have metadata.sent_by = 'human'. Caye auto-replies
      // have metadata.generated_by = 'caye' (and no sent_by). We accept the
      // former and reject the latter.
      return meta.sent_by === 'human' && meta.generated_by !== 'caye'
    })
    .map(row => (row.content ?? '').trim())
    .filter(Boolean)
    .slice(0, SAMPLE_SIZE)
}
