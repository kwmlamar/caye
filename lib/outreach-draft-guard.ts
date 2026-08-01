/**
 * Pre-send validation for cold-outreach drafts.
 *
 * Exists because the draft generator is an LLM and does not reliably obey
 * its own instructions: in the 2026-08-01 follow-up batch, 7 of 31 sent
 * emails contained the exact hedge phrases lib/outreach-nudge.ts's prompt
 * explicitly bans, and one shipped a literal unfilled "[First Name]"
 * placeholder to a real prospect. Prompt text is a request; this is the
 * enforcement.
 *
 * This module is the single source of truth for the ban list —
 * outreach-nudge.ts builds its prompt from BANNED_HEDGE_PHRASES rather
 * than restating them, so the instruction and the check can't drift apart.
 *
 * Cold email is irreversible: once it's out, it's out. So this fails
 * CLOSED — anything suspicious blocks the send and hands the draft back to
 * the operator rather than guessing that it's probably fine.
 */

/**
 * Soft American customer-service hedges. Banned per the Bahamian-directness
 * voice rule: direct and blunt, not cushioned. Lowercase — matching is
 * case-insensitive.
 */
export const BANNED_HEDGE_PHRASES: readonly string[] = [
  'just floating this back up',
  'floating this back up',
  'no rush',
  'no worries at all',
  'no worries',
  'just wanted to check in',
  'just checking in',
  'sorry to bother',
  'hope this finds you well',
]

/**
 * Unfilled merge-field placeholders the generator sometimes leaves behind
 * instead of substituting real values: [First Name], {{business}}, {city}.
 *
 * The bracket pattern deliberately requires the contents to look like a
 * field name (letters/spaces/underscores/hyphens, no sentence punctuation)
 * so ordinary prose in brackets — an aside, a citation — doesn't trip it.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\[[A-Za-z][A-Za-z _-]{0,38}\]/g,
  /\{\{[^}]{1,40}\}\}/g,
  /\{[A-Za-z][A-Za-z _-]{0,38}\}/g,
]

export interface DraftIssue {
  kind: 'placeholder' | 'hedge_phrase'
  /** The exact offending text, for an operator-readable error. */
  detail: string
}

/**
 * Returns every reason this draft must not be sent as-is. Empty array means
 * it passed.
 */
export function findOutreachDraftIssues(text: string): DraftIssue[] {
  const issues: DraftIssue[] = []
  const seen = new Set<string>()

  for (const pattern of PLACEHOLDER_PATTERNS) {
    // Fresh lastIndex per call — these are module-level /g regexes and
    // would otherwise resume mid-string across invocations.
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const found = match[0]
      const key = `placeholder:${found.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      issues.push({ kind: 'placeholder', detail: found })
    }
  }

  const lowered = text.toLowerCase()
  for (const phrase of BANNED_HEDGE_PHRASES) {
    if (!lowered.includes(phrase)) continue
    // Skip a shorter phrase already covered by a longer match reported
    // above ("no worries" inside "no worries at all") so one mistake
    // doesn't read as two.
    const redundant = issues.some(
      (i) => i.kind === 'hedge_phrase' && i.detail.toLowerCase().includes(phrase)
    )
    if (redundant) continue
    issues.push({ kind: 'hedge_phrase', detail: phrase })
  }

  return issues
}

/** One-line, operator-readable summary of why a draft was blocked. */
export function describeDraftIssues(issues: DraftIssue[]): string {
  const placeholders = issues.filter((i) => i.kind === 'placeholder').map((i) => i.detail)
  const hedges = issues.filter((i) => i.kind === 'hedge_phrase').map((i) => `"${i.detail}"`)
  const parts: string[] = []
  if (placeholders.length > 0) {
    parts.push(`unfilled placeholder ${placeholders.join(', ')}`)
  }
  if (hedges.length > 0) {
    parts.push(`banned hedge phrase ${hedges.join(', ')}`)
  }
  return `draft blocked — ${parts.join('; ')}. Rewrite it before sending.`
}
