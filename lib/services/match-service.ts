/**
 * match-service.ts
 *
 * Fuzzy-match a customer's stated tour name against the canonical
 * booking_services list. Used to give the LLM a strong hint before it
 * picks a service_id, so a customer typing "North Bimini Historical Tour"
 * doesn't cause Caye to punt because the catalog says "North Bimini Heritage
 * Tour".
 *
 * Background: Jeff Montenaro 2026-06-05 + James Stallings 2026-05-29 both
 * showed the same failure mode — service-name mismatch upstream of the
 * deterministic tier lookup caused Caye to DEFER instead of quote. The
 * deterministic tier path is fine; the name match is the gap.
 *
 * Pure function. DB lookup happens in the caller.
 */

export interface CandidateService {
  id: string
  name: string
}

export type MatchConfidence = 'high' | 'medium' | 'low' | 'none'

export interface ServiceMatchResult {
  /** The customer's input string (the raw tour name they typed). */
  query: string
  /** The single best canonical service when confidence is high. */
  best: CandidateService | null
  /** Confidence of the best match. */
  confidence: MatchConfidence
  /**
   * Top 2-3 candidates with their scores. Useful for the LLM when
   * confidence is medium/low — it can clarify between named options.
   */
  candidates: Array<{ service: CandidateService; score: number }>
}

/**
 * Words that appear in nearly every Bimini tour name and therefore carry
 * little discriminating signal. Down-weighted so matches don't pile up on
 * shared filler ("Tour", "Experience") and miss the distinguishing token
 * (e.g. "Heritage" vs "Sit-Low" vs "Eat").
 */
const LOW_SIGNAL_WORDS = new Set([
  'tour', 'tours', 'experience', 'bimini', 'bahamas', 'island', 'a', 'an', 'the',
  'of', 'and', 'with', 'on', 'in', 'at', 'for', 'to', 'min', 'mins', 'minute',
  'minutes', 'hr', 'hrs', 'hour', 'hours',
])

/**
 * Token-equivalence map for known customer paraphrases. Resolved at tokenize
 * time so a customer's "historical" matches a catalog "heritage". Bidirectional.
 * Keep additions conservative — over-aliasing collapses distinctions.
 */
const SYNONYMS: Array<[string, string]> = [
  ['historical', 'heritage'],
  ['history', 'heritage'],
  ['historic', 'heritage'],
  ['cultural', 'heritage'],
  ['food', 'eat'],
  ['culinary', 'eat'],
  ['tasting', 'eat'],
  ['sightsee', 'sit'],
  ['sightseeing', 'sit'],
  ['lookout', 'sit'],
  ['sit-low', 'sit'],
  ['sitlow', 'sit'],
  ['orientation', 'orientation'],
  ['intro', 'orientation'],
  ['introduction', 'orientation'],
  ['guided', 'guided'],
  ['fully', 'guided'],
  ['private', 'private'],
  ['ponce', 'ponce'],
  ['fountain', 'ponce'],
  ['youth', 'ponce'],
  ['south', 'south'],
  ['north', 'north'],
  ['full', 'full'],
  ['combo', 'full'],
  ['combination', 'full'],
  ['cart', 'cart'],
  ['golf', 'golf'],
  ['heritage', 'heritage'],
  ['eat', 'eat'],
  ['sit', 'sit'],
]

const SYNONYM_MAP: Map<string, string> = (() => {
  const m = new Map<string, string>()
  for (const [from, to] of SYNONYMS) m.set(from, to)
  return m
})()

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/^-+|-+$/g, '').trim())
    .filter(Boolean)
    .map(t => SYNONYM_MAP.get(t) ?? t)
}

/**
 * Per-token weight: low-signal filler counts for less.
 * 1.0 for content tokens, 0.2 for filler.
 */
function tokenWeight(t: string): number {
  return LOW_SIGNAL_WORDS.has(t) ? 0.2 : 1.0
}

/**
 * Weighted Jaccard similarity over token sets.
 * Score = sum(weight of shared tokens) / sum(weight of unique tokens in union).
 */
function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  const union = new Set([...setA, ...setB])
  let shared = 0
  let total = 0
  for (const t of union) {
    const w = tokenWeight(t)
    total += w
    if (setA.has(t) && setB.has(t)) shared += w
  }
  return total === 0 ? 0 : shared / total
}

/**
 * Bonus when one tokenized name is a substring of the other (e.g. customer
 * "Golf Cart" ⊂ catalog "Golf Cart Guided Tour"). Avoids cases where short
 * inputs lose because the long catalog name has more unique tokens.
 */
function substringBonus(query: string[], candidate: string[]): number {
  if (!query.length) return 0
  const qStr = query.join(' ')
  const cStr = candidate.join(' ')
  if (cStr.includes(qStr) || qStr.includes(cStr)) return 0.15
  return 0
}

export interface MatchOptions {
  /** Minimum score for the best match to be returned as 'high'. */
  highThreshold?: number
  /** Best score must exceed runner-up by this margin to be 'high'. */
  highMargin?: number
  /** Minimum score for 'medium' (returned as best but flagged). */
  mediumThreshold?: number
  /** Max number of candidates included in the result. */
  maxCandidates?: number
}

const DEFAULTS: Required<MatchOptions> = {
  highThreshold: 0.45,
  highMargin: 0.12,
  mediumThreshold: 0.25,
  maxCandidates: 3,
}

/**
 * Match a customer's stated tour name against the canonical service list.
 *
 * Confidence levels:
 *  - 'high'   — score >= highThreshold AND lead over runner-up >= highMargin.
 *               LLM should use best.id directly in lookup_price.
 *  - 'medium' — score >= mediumThreshold but not 'high'. LLM should CLARIFY
 *               between the top candidates rather than guess.
 *  - 'low'    — best score < mediumThreshold. LLM should CLARIFY by listing
 *               all available services. (Still better than DEFER.)
 *  - 'none'   — empty query or no services configured.
 */
export function matchServiceByName(
  services: CandidateService[],
  query: string,
  options?: MatchOptions
): ServiceMatchResult {
  const opts = { ...DEFAULTS, ...(options ?? {}) }
  const cleanQuery = (query ?? '').trim()

  if (!cleanQuery || !services.length) {
    return { query: cleanQuery, best: null, confidence: 'none', candidates: [] }
  }

  const qTokens = tokenize(cleanQuery)
  if (!qTokens.length) {
    return { query: cleanQuery, best: null, confidence: 'none', candidates: [] }
  }

  const scored = services.map(svc => {
    const cTokens = tokenize(svc.name)
    const base = similarity(qTokens, cTokens)
    const bonus = substringBonus(qTokens, cTokens)
    return { service: { id: svc.id, name: svc.name }, score: base + bonus }
  })

  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, opts.maxCandidates)
  const [first, second] = scored

  if (!first || first.score === 0) {
    return { query: cleanQuery, best: null, confidence: 'none', candidates: top }
  }

  const lead = first.score - (second?.score ?? 0)

  let confidence: MatchConfidence
  if (first.score >= opts.highThreshold && lead >= opts.highMargin) {
    confidence = 'high'
  } else if (first.score >= opts.mediumThreshold) {
    confidence = 'medium'
  } else {
    confidence = 'low'
  }

  return {
    query: cleanQuery,
    best: first.service,
    confidence,
    candidates: top,
  }
}

/**
 * Extract a customer-stated tour name from an inbound message body. Handles
 * intake-form structured input ("Tour: Golf Cart Guided Tour") and basic
 * free-text "the Heritage tour" patterns. Returns null when nothing
 * tour-name-like is found — caller should fall back to the full LLM prompt
 * without a match hint.
 */
export function extractCustomerTourName(body: string): string | null {
  if (!body) return null

  // Intake form: "Tour: <name>" on its own line. This is the strongest signal
  // — it's a structured field from the website booking form.
  const intakeMatch = body.match(/^\s*Tour\s*:\s*(.+?)\s*$/im)
  if (intakeMatch && intakeMatch[1]) {
    const name = intakeMatch[1].trim()
    // Strip trailing punctuation
    return name.replace(/[.,;:!?]+$/, '').trim() || null
  }

  // Free-text: "the X tour" / "X experience" patterns. Conservative —
  // only fires for capitalized phrases to avoid false positives like
  // "the food was great".
  // Case-sensitive on the captured phrase (must start with a capital letter)
  // to avoid false positives like "the food was great on our tour". Suffix
  // accepts either case so we still match "the Heritage Tour" and "the
  // Heritage tour" equivalently.
  const freeText = body.match(
    /\b(?:the|a|an|book(?:ing)?|do(?:ing)?|interested in|want(?:ed)? to do)\s+(?:the\s+)?([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,4})\s+(?:[Tt]our|[Ee]xperience|[Tt]rip|[Ee]xcursion)\b/
  )
  if (freeText && freeText[1]) {
    return freeText[1].trim() || null
  }

  return null
}

/**
 * Build a system-prompt block that surfaces the match result to the LLM.
 * Designed to be appended to the existing AVAILABLE SERVICES block.
 * Empty string when nothing useful to add — caller should append unconditionally.
 */
export function buildMatchHintBlock(result: ServiceMatchResult): string {
  if (result.confidence === 'none' || !result.best) return ''

  if (result.confidence === 'high') {
    return (
      '\n\nINTERPRETED CUSTOMER REQUEST (HIGH CONFIDENCE):\n' +
      `- Customer wrote: "${result.query}"\n` +
      `- Best canonical match: "${result.best.name}" [id: ${result.best.id}]\n` +
      '- Use this service_id in lookup_price. Do NOT defer the conversation ' +
      'just because the customer\'s phrasing differs from the catalog name. ' +
      'If you have ANY doubt, CLARIFY (option 1 in the AUTONOMY DECISION TREE) ' +
      'by naming the canonical tour — never DEFER on a pure name mismatch.'
    )
  }

  const candList = result.candidates
    .filter(c => c.score > 0)
    .map(c => `  - "${c.service.name}" [id: ${c.service.id}]`)
    .join('\n')

  return (
    `\n\nAMBIGUOUS CUSTOMER REQUEST (${result.confidence.toUpperCase()} CONFIDENCE):\n` +
    `- Customer wrote: "${result.query}"\n` +
    '- Closest canonical matches:\n' +
    candList +
    '\n' +
    '- CLARIFY (option 1 in the AUTONOMY DECISION TREE) by naming these specific ' +
    'options. Do NOT DEFER on a name mismatch — the customer can resolve this in ' +
    'one reply by picking from the list.'
  )
}
