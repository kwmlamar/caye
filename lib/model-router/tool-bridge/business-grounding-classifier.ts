import 'server-only'

/**
 * Deterministic, request-side routing decision: does the founder's latest
 * message plausibly require checking real workspace/business state to
 * answer honestly? This is NOT a fabrication detector (that job stays with
 * protocol-artifact-guard.ts, applied to the model's OUTPUT) — it's an
 * orchestration signal, applied to the INPUT, that decides whether
 * founder-tool-loop.ts is allowed to accept a plain-text first answer at
 * all before any real tool has run this turn. See
 * founder-tool-loop.ts's `requiresGrounding` for the enforcement.
 *
 * WHY THIS SHAPE (2026-08-17, after real Claude runs surfaced a second
 * failure mode): asking "Look up the customer named Juli King..." twice in
 * 8 real subscription-CLI runs produced a fully confident, fully invented
 * answer with ZERO tool calls and ZERO protocol artifacts — nothing for a
 * text-scanning guard to catch, because the fabrication wasn't narrating
 * the tool protocol, it was just... answering. The fix has to happen
 * before the model ever gets to answer, not after.
 *
 * DESIGN: fail CLOSED, not fail open. Rather than trying to enumerate every
 * shape of "this needs business data" (open-ended, unbounded, exactly the
 * kind of lexical arms race the router brief explicitly ruled out), this
 * enumerates the NARROW, closed set of requests that provably do NOT need
 * it — meta questions about Caye itself, and pure rewrite/draft/transform
 * instructions operating on content already pasted inline in the same
 * message — and defaults to requiring grounding for everything else. A
 * false positive here costs one extra forced tool round (annoying, safe).
 * A false negative recreates the exact bug this exists to close. The
 * asymmetry is the whole point.
 */

const META_ABOUT_CAYE_PATTERNS: readonly RegExp[] = [
  /\bwhat can you do\b/i,
  /\bwhat do you do\b/i,
  /\bhow do you work\b/i,
  /\bhow does (your|the) .* work\b/i,
  /\bexplain how (your|the) .* works?\b/i,
  /\bwhat are you\b/i,
  /\bwho are you\b/i,
  /\bwhat tools do you have\b/i,
  /\bwhat can i ask you\b/i,
]

/** Leading imperative verb, not a substring match — "draft" mid-sentence about something else shouldn't count. */
const LEADING_TRANSFORM_VERB = /^\s*(please\s+)?(draft|rewrite|reword|edit|polish|proofread|shorten|summarize|summarise|translate|paraphrase|tighten)\b/i

/** Signals the content being transformed is supplied in this same message, not fetched. */
const REFERENCES_INLINE_CONTENT = /[:"']|this (message|sentence|text|reply|note|paragraph)|the following|below/i

function isMetaAboutCaye(text: string): boolean {
  return META_ABOUT_CAYE_PATTERNS.some((p) => p.test(text))
}

function isPureTransformOfInlineContent(text: string): boolean {
  return LEADING_TRANSFORM_VERB.test(text) && REFERENCES_INLINE_CONTENT.test(text)
}

export function requiresBusinessGrounding(latestUserText: string): boolean {
  const text = latestUserText.trim()
  if (!text) return false
  if (isMetaAboutCaye(text)) return false
  if (isPureTransformOfInlineContent(text)) return false
  return true
}
