/**
 * Pure text handling for the one-example-per-onboarding-question rule.
 * Extracted from lib/onboarding.ts so it can be unit tested without
 * pulling in server-only.
 *
 * decideNextDiscoveryStep asks the model for a question and a separate
 * suggested_answer, and onboarding-whatsapp renders the latter as its own
 * `(e.g. "…")` line. The model routinely inlines an example into the
 * question text as well, which makes the owner read two examples for one
 * question. The prompt tells it not to; this strips it when it does
 * anyway, because prompt text is not enforcement.
 */

// Matches the lead-in to an inline example — an optional dash/paren run
// followed by "e.g." / "for example" / "for instance". The \b goes on the
// front of each alternative only: "e.g." ends in a period, so a trailing
// \b would never match the space that follows it. Leading \b is what keeps
// this off word-internal hits ("leg.", "keg."). Case-insensitive, first
// hit wins, everything after it is the example.
const INLINE_EXAMPLE_RE =
  /\s*[—–-]?\s*\(?\s*(?:\be\.g\.|\beg\.|\bfor example\b|\bfor instance\b)[:,]?\s*/i

// Quotes/parens the model wraps examples in. Stripped from both ends only,
// so apostrophes inside the example ("We're relaxed") survive.
const WRAPPING_START = /^[\s'"“”‘’(]+/
const WRAPPING_END = /[\s'"“”‘’)]+$/

/** Strips the quotes/parens a model wraps an example answer in. */
export function unwrapExample(text: string): string {
  return text.replace(WRAPPING_START, '').replace(WRAPPING_END, '').trim()
}

/**
 * Splits an inline "e.g. …" clause off a question. Returns the question
 * without it, plus the example so the caller can promote it to
 * suggestedAnswer when the model didn't supply one separately — stripping
 * should never lose the example, only relocate it.
 */
export function splitInlineExample(question: string): {
  question: string
  example: string | null
} {
  const match = question.match(INLINE_EXAMPLE_RE)
  if (!match || match.index === undefined) {
    return { question: question.trim(), example: null }
  }

  const head = question.slice(0, match.index)
  const tail = question.slice(match.index + match[0].length)

  // A question that is *only* an example isn't one — leave it alone rather
  // than hand back an empty question.
  if (!head.trim()) return { question: question.trim(), example: null }

  // Trailing separators are the model's join between question and example
  // ("…what we should know — e.g."). Note `?` and `!` are deliberately not
  // stripped: they end the question itself.
  const cleaned = head.replace(/[\s—–\-:;,(]+$/, '').trim()
  const example = unwrapExample(tail)

  return { question: cleaned || question.trim(), example: example || null }
}
