/**
 * Turns a raw caye_escalations row into what FounderHome's "Needs You" card
 * (AttentionCard.tsx) actually renders — a short, jargon-free briefing plus a
 * priority order for when more than one is open. Pulled out of the component
 * so both pieces are unit-testable without React.
 *
 * Detailed reasoning (category, route_to, the full internal_context) stays
 * available in Inbox/CayeHandoff — this module only decides what's safe and
 * useful to put in front of the founder in five seconds on Home.
 */

import type { Escalation } from './useCommandOverview'
import { founderBriefingLeak } from './operator-text-guard'

/** Human phrasing for the four real category values — never surfaced as the
 *  raw enum. Used when there's no clean free text to show instead. */
const CATEGORY_FALLBACK: Record<string, string> = {
  gap: "I couldn't fully answer their question and didn't want to guess.",
  policy: "This falls outside a policy I know, so I didn't want to decide on my own.",
  knowledge: "I don't have this on file, so I didn't want to guess.",
  sensitive: 'This needs your judgment, not mine.',
}
const DEFAULT_FALLBACK = "I wasn't confident enough to handle this on my own."

// Kept modest so the two pieces together land near the ~40-70 word target —
// a card can't stay compact if the "why" and the "decision" are each
// separately capped at 70.
const MAX_BODY_WORDS = 50
const MAX_DECISION_WORDS = 32

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length <= maxWords) return text
  return words.slice(0, maxWords).join(' ') + '…'
}

/** Splits on sentence-ending punctuation, keeping it attached to each piece. */
function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?]+[.!?]*/g) ?? [text]
  return matches.map((s) => s.trim()).filter(Boolean)
}

export interface Briefing {
  /** The explanatory paragraph — never raw jargon. */
  body: string
  /** The trailing yes/no ask, split out for visual emphasis, when the
   *  source text genuinely ends in a question. Null otherwise — never
   *  synthesized. */
  decision: string | null
}

/**
 * Chooses and cleans the text for one escalation. Prefers internal_context
 * (Caye's own note — plain-English by design, see evidence.ts's
 * ownerNoteFor) but only when it actually reads clean; falls back to
 * customer_facing_message (already vetted for an external reader by
 * guardDraft before it was sent) when internal_context is empty; falls back
 * to a category-based generic line when the only text available leaks
 * internal machinery.
 */
export function summarizeEscalation(e: Pick<Escalation, 'internal_context' | 'customer_facing_message' | 'category'>): Briefing {
  const internal = e.internal_context?.trim()
  const customerFacing = e.customer_facing_message?.trim()

  let source: string
  if (internal && !founderBriefingLeak(internal)) {
    source = internal
  } else if (customerFacing) {
    source = customerFacing
  } else {
    source = (e.category && CATEGORY_FALLBACK[e.category]) || DEFAULT_FALLBACK
  }

  // Split off a trailing decision question BEFORE truncating — the
  // escalate_to_team tool schema asks the model to always end with a
  // concrete yes/no ask, so on a real escalation that question is often
  // what pushes the total past a flat word cap. A live example from
  // production: 103 words total, all of it genuine, with the actual
  // decision as the last 20-word sentence — truncating the whole thing
  // first would have cut the ask itself.
  const sentences = splitSentences(source)
  const last = sentences[sentences.length - 1]
  if (sentences.length >= 2 && last?.trim().endsWith('?')) {
    return {
      body: truncateWords(sentences.slice(0, -1).join(' '), MAX_BODY_WORDS),
      decision: truncateWords(last.trim(), MAX_DECISION_WORDS),
    }
  }
  return { body: truncateWords(source, MAX_BODY_WORDS), decision: null }
}

/** Short, human category label for the WHO/topic line when there's no
 *  booking-linked service name to use instead. */
export const CATEGORY_TOPIC_LABEL: Record<string, string> = {
  gap: 'A question',
  policy: 'A policy call',
  knowledge: "Something she doesn't know",
  sensitive: 'Needs your judgment',
}

/**
 * Highest-priority-first. category/route_to don't carry a reliable urgency
 * signal — complaint, refund, custom_request and b2b_partnership all
 * collapse into just 'policy' or 'sensitive' by which trigger fired, not by
 * severity (see forced-escalation.ts's classifier). The two real,
 * unambiguous signals available are: whether actual money/logistics are on
 * the line (a linked booking — the user's "booking/payment issues" tier),
 * and failing that, how long it's been open (oldest first — was already the
 * only sort order before this).
 */
export function sortEscalationsByPriority<T extends Pick<Escalation, 'booking_meta' | 'created_at'>>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const aTier = a.booking_meta ? 0 : 1
    const bTier = b.booking_meta ? 0 : 1
    if (aTier !== bTier) return aTier - bTier
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  })
}
