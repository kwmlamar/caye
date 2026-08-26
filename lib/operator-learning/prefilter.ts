/**
 * operator-learning/prefilter.ts
 *
 * Cheap, deterministic pre-filter that runs BEFORE any LLM call. Two jobs:
 *   1. Skip obviously non-teaching messages (too short, a bare
 *      acknowledgement, a question) without spending a classifier call.
 *   2. Flag obvious one-off language so an unambiguous "just for this guest"
 *      statement never even reaches the classifier as a candidate for a
 *      standing rule.
 *
 * Deliberately conservative in ONE direction only: it is allowed to let
 * ambiguous or borderline text THROUGH to the classifier (a wasted LLM call
 * is cheap), but it must never filter out something that could plausibly be
 * durable knowledge (a missed correction is the exact failure this whole
 * feature exists to close). See lib/business-fact-candidate-detection.ts for
 * the sibling convention this follows.
 *
 * Design reference only: the shape of these heuristics mirrors the unmerged
 * issue #121 branch (lib/operator-learning.ts on
 * codex/issue-121-durable-operator-learning) — rewritten here, not imported,
 * since that branch is not being merged.
 */

const MIN_LENGTH = 8

/** A short reply that is almost certainly not new content worth classifying. */
const BARE_ACKNOWLEDGEMENT = /^(ok|okay|k|yes|yep|yeah|sure|thanks|thank you|got it|sounds good|perfect|great|👍|✅)[.!]?$/i

/** A question the operator is asking Caye, not teaching Caye — starts with a wh-word/aux verb and ends in '?'. */
function looksLikeQuestion(text: string): boolean {
  return /\?\s*$/.test(text.trim()) && /^(what|when|where|who|why|how|is|are|can|could|did|does|do)\b/i.test(text.trim())
}

/**
 * Explicit customer/booking-scoped language — "for X only", "this guest
 * only", "just this time". A hard signal for scope.kind === 'customer_scoped'
 * or 'one_off'; the classifier still assigns the final scope, but this lets
 * the router avoid ever asking the classifier to justify overriding an
 * explicit one-off marker.
 */
const OBVIOUS_ONE_OFF =
  /\b(?:for\s+(?:this|that)\s+(?:guest|customer|booking)\s+only|this\s+(?:guest|customer|booking|time)\s+only|just\s+(?:for|this)\b|one[- ]?time\s+(?:only|discount|exception)|give\s+(?:this|that|her|him|them)\b.*\bfor\s+\$)/i

/** Explicit durable-scope language — "always", "from now on", "we only", "never", "going forward". */
const OBVIOUS_DURABLE =
  /\b(?:always|from now on|going forward|we only\b|never\b|whenever|each time|for (?:all|every)\b)/i

/** A specific calendar date mentioned in the message — "that day", "September 5" — a signal for scope.kind === 'date_scoped'. */
const EXPLICIT_DATE_MARKER = /\b(?:that day|this date|\bon\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\d{4}-\d{2}-\d{2}|\b\d{1,2}\/\d{1,2}\b)/i

export interface PrefilterResult {
  /** False means: do not call the classifier at all. */
  worthClassifying: boolean
  reason: string
  hints: {
    obviousOneOff: boolean
    obviousDurable: boolean
    mentionsSpecificDate: boolean
  }
}

export function prefilterOperatorMessage(text: string): PrefilterResult {
  const trimmed = text.trim()

  if (trimmed.length < MIN_LENGTH) {
    return { worthClassifying: false, reason: 'too short to plausibly contain reusable knowledge', hints: emptyHints() }
  }
  if (BARE_ACKNOWLEDGEMENT.test(trimmed)) {
    return { worthClassifying: false, reason: 'bare acknowledgement, no new content', hints: emptyHints() }
  }
  if (looksLikeQuestion(trimmed)) {
    return { worthClassifying: false, reason: 'operator is asking a question, not teaching', hints: emptyHints() }
  }

  return {
    worthClassifying: true,
    reason: 'passed deterministic prefilter',
    hints: {
      obviousOneOff: OBVIOUS_ONE_OFF.test(trimmed),
      obviousDurable: OBVIOUS_DURABLE.test(trimmed),
      mentionsSpecificDate: EXPLICIT_DATE_MARKER.test(trimmed),
    },
  }
}

function emptyHints() {
  return { obviousOneOff: false, obviousDurable: false, mentionsSpecificDate: false }
}
