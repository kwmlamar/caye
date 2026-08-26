/**
 * Deterministic quality gate on an escalation's internal_context — the text
 * that becomes the owner/founder's `human_agent_reason` and WhatsApp ping.
 *
 * escalate_to_team's tool description already tells the model what a good
 * handoff looks like (2-5 sentences, ends in a concrete yes/no proposal —
 * see lib/caye-reply.ts). That's a prompt instruction, not a guarantee: a
 * model can still emit "Caye couldn't figure this out" and call it a day.
 * This is the code-level backstop — not a semantic understanding of whether
 * the reason is CORRECT (that needs judgment this function doesn't have),
 * but a cheap, deterministic check for the shape every genuine handoff has:
 * enough words to say what's actually going on, sentence structure, and not
 * one of the bare hedge-phrases that mean "I'm not sure" dressed up as a
 * reason.
 *
 * Never blocks the escalation — a customer's message already went out and
 * an operator is already being pinged; withholding the ping over a
 * low-quality reason would trade a legible problem for a silent one. This
 * only produces a structured signal (logged, and available to attach to the
 * escalation's audit trail) so a genuinely vague "Needs You" is visible as
 * a data-quality issue rather than invisible inside normal-looking prose.
 */

export interface EscalationReasonQuality {
  ok: boolean
  concerns: EscalationReasonConcern[]
}

export type EscalationReasonConcern = 'too_short' | 'boilerplate_uncertainty' | 'no_sentence_structure'

const MIN_LENGTH = 20

// Bare hedge-phrases that name no concrete blocker — "I don't know" is not
// the same as "I don't know which partner Bimini uses for Snuba, and
// whether we quote or refer directly." The second is a real handoff; the
// first is uncertainty theater. Anchored so a real sentence that happens to
// contain "not sure" mid-clause ("I'm not sure if $90 or $110 is current —
// the last two bookings priced it differently") doesn't false-positive.
const BOILERPLATE_PATTERNS: RegExp[] = [
  /^(i'?m )?(not sure|unsure|unclear|no idea)\.?$/i,
  /^(i )?(don'?t|do not) know\.?$/i,
  /^(needs? (more )?(info|information|context|review))\.?$/i,
  /^(i )?(couldn'?t|could not|can'?t|cannot) (help|respond|handle|figure (it|this) out)\.?$/i,
  /^(this )?(is|was) (ambiguous|unclear|confusing)\.?$/i,
]

export function assessEscalationReasonQuality(internalContext: string): EscalationReasonQuality {
  const trimmed = internalContext.replace(/\s+/g, ' ').trim()
  const concerns: EscalationReasonConcern[] = []

  if (trimmed.length < MIN_LENGTH) concerns.push('too_short')
  if (BOILERPLATE_PATTERNS.some((re) => re.test(trimmed))) concerns.push('boilerplate_uncertainty')
  if (trimmed.length > 0 && !/[.?!]/.test(trimmed)) concerns.push('no_sentence_structure')

  return { ok: concerns.length === 0, concerns }
}
