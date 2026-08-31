import { normalizeSpokenPunctuation } from './spoken-text'

/**
 * Conservative voice-only hints for obvious read questions.
 *
 * This never grants authority and never executes a tool directly. It only
 * narrows the manifest shown to the existing founder tool loop, which still
 * resolves the named tool from TOOL_REGISTRY and applies the normal role,
 * grounding, execution, evidence, and action-claim guards.
 *
 * Ambiguous, compound, or action-shaped utterances return undefined and keep
 * the full founder tool surface. False negatives cost latency; false positives
 * could hide a needed tool, so this deliberately recognizes only narrow reads.
 */
export function voiceReadToolHints(message: string): readonly string[] | undefined {
  const text = normalizeSpokenPunctuation(message).trim().toLowerCase()
  if (!text) return undefined

  if (/\b(add|change|update|set|remove|delete|send|reply|message|book|cancel|reschedule|create|run|start|stop|pause|resume|approve|confirm|schedule|notify|mark|mute|unmute|archive|record)\b/.test(text)) {
    return undefined
  }
  if (/\b(and then|then |also |after that|while you|and (?:add|change|update|send|book|cancel|create|run|schedule))\b/.test(text)) {
    return undefined
  }

  if (/\b(tours?|services?|offerings?)\b/.test(text) && /\b(what|which|list|offer|have|available)\b/.test(text)) return ['get_services']
  if (/\b(bookings?|reservations?)\b/.test(text) && /\b(recent|latest|today|upcoming|what|which|list|have)\b/.test(text)) return ['get_recent_bookings']
  if (/\b(revenue|sales|money|earnings?)\b/.test(text) && /\b(today|recent|current|how much|what|show|looking)\b/.test(text)) return ['get_revenue']
  if (/\b(channels?|whatsapp|email|zoho)\b/.test(text) && /\b(status|connected|working|online|setup|set up)\b/.test(text)) return ['get_channel_status']
  if (/\b(team|staff|employees?|members?)\b/.test(text) && /\b(who|list|have|on the team|members?)\b/.test(text)) return ['get_team_members']
  if (/\b(goals?|priorities)\b/.test(text) && /\b(active|current|what|which|list|have)\b/.test(text)) return ['list_active_goals']

  return undefined
}
