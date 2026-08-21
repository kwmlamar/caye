import 'server-only'
import type { VoiceObservabilityEvent } from './types'

/**
 * Founder-safe structured logging for voice sessions (spec item 18).
 * Deliberately console-only, not a new DB table: this feature is explicitly
 * "implement locally, do not deploy" (spec item 22) and a schema migration
 * for an unreviewed, undeployed surface is more commitment than the data
 * needs yet. `[caye-voice]`-prefixed structured lines are enough to compare
 * providers/latency by grepping Vercel logs once this graduates to a real
 * test; promoting this to a table (mirroring llm_call_log) is a natural,
 * separate follow-up once the founder has run real sessions.
 *
 * Never logs audio bytes or transcript/reply text — only metadata (provider,
 * duration, character/byte counts, fallback reasons).
 */
export function logVoiceEvent(event: VoiceObservabilityEvent): void {
  console.log(`[caye-voice] ${event.event}`, JSON.stringify(event))
}

export function newVoiceSessionId(): string {
  return `voice_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}
