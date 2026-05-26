/**
 * Pure trigger + channel-filter logic for the owner voice profile
 * refresher. Extracted from owner-voice-learning.ts so it can be unit
 * tested without pulling in Supabase / Anthropic.
 */

/**
 * Channels we currently trust as clean data sources for voice learning.
 * Per project_caye_channel_data_quality: WhatsApp/Instagram/Messenger
 * connected accounts are shared test connections across workspaces and
 * would pollute the owner's voice profile. Once real per-workspace
 * connections exist for those channels, add them here.
 */
export const TRUSTED_VOICE_CHANNELS = ['email'] as const
type TrustedVoiceChannel = (typeof TRUSTED_VOICE_CHANNELS)[number]

/**
 * How many new owner-sent messages must accumulate before we re-extract
 * the voice profile. Each successful re-extraction resets the counter,
 * so profiles refresh at 10, 20, 30, ... owner messages.
 */
export const REFRESH_EVERY = 10

export function isTrustedVoiceChannel(channel: string): boolean {
  return (TRUSTED_VOICE_CHANNELS as readonly string[]).includes(channel)
}

/**
 * Should we re-extract the owner's voice profile given the current
 * count of trusted-channel owner messages since the last update?
 */
export function shouldRefreshOwnerVoiceProfile(newCount: number): boolean {
  return newCount >= REFRESH_EVERY
}
