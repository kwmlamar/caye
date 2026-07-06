/**
 * Pure detection logic for spotting business facts the owner is already
 * teaching guests by hand, repeatedly, without ever using
 * add_business_fact. Extracted so it can be unit tested without Supabase.
 *
 * Confirmed live (Bridgette Jones / Bimini, 2026-07-04/05): pickup point,
 * phone numbers, and cancellation policy were retyped near-verbatim across
 * 15+ conversations from 2026-04-27 through 2026-07-05 — none of it ever
 * made it into business_facts.
 *
 * Scope is deliberately narrow: only sentences that read as STABLE
 * knowledge (pickup point, contact info, cancellation policy) are
 * candidates. Sentences naming a guide, or carrying day-of times/prices,
 * are excluded — those rotate per booking and would go stale if captured
 * as a fixed fact (confirmed: Bridgette's guide was James Edden, an
 * earlier customer's was Aladdin).
 */

export const OCCURRENCE_THRESHOLD = 3

const MIN_SENTENCE_LENGTH = 25
const MAX_SENTENCE_LENGTH = 300

/** Substrings (lowercase) that mark a sentence as reusable business knowledge. */
const STABLE_FACT_KEYWORDS = [
  'pick-up',
  'pickup',
  'meeting point',
  'tram stop',
  'casino',
  'resorts world',
  'dock',
  'pier',
  'cancellation',
  'refund',
  'telephone',
  'whatsapp/imessage',
  'office:',
]

/** Any sentence naming a specific guide is per-booking, not a standing fact. */
const VOLATILE_MARKERS = ['guide']

export type CategoryGuess = 'policy' | 'service_detail' | 'special_handling' | 'logistics'

/** Split a message body into trimmed, non-empty sentences. */
export function splitIntoSentences(content: string): string[] {
  return content
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/** Is this sentence worth tracking as a candidate standing fact? */
export function isCandidateSentence(sentence: string): boolean {
  if (sentence.length < MIN_SENTENCE_LENGTH || sentence.length > MAX_SENTENCE_LENGTH) return false
  const lower = sentence.toLowerCase()
  if (VOLATILE_MARKERS.some(m => lower.includes(m))) return false
  return STABLE_FACT_KEYWORDS.some(k => lower.includes(k))
}

/** Pull every candidate-worthy sentence out of a message body. */
export function extractCandidateSentences(content: string): string[] {
  return splitIntoSentences(content).filter(isCandidateSentence)
}

/**
 * Canonical form used as the dedup key across conversations. Strips
 * punctuation/whitespace variance so near-identical retypes collapse to
 * the same row. Deliberately NOT fuzzy (no similarity scoring) — keeps
 * false-merges at zero at the cost of missing paraphrased repeats, which
 * is the safer failure mode for something that gets surfaced to the owner.
 */
export function normalizeSentence(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function guessCategory(sentence: string): CategoryGuess {
  const lower = sentence.toLowerCase()
  if (lower.includes('refund') || lower.includes('cancel')) return 'policy'
  if (
    STABLE_FACT_KEYWORDS.some(k => k !== 'cancellation' && k !== 'refund' && lower.includes(k))
  ) {
    return 'logistics'
  }
  return 'service_detail'
}

/** Should this candidate be proposed to the owner right now? */
export function shouldProposeCandidate(
  status: 'pending' | 'proposed' | 'resolved' | 'dismissed',
  occurrenceCount: number
): boolean {
  return status === 'pending' && occurrenceCount >= OCCURRENCE_THRESHOLD
}
