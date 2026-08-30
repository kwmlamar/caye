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
 * Keep the safe default (ground business/state questions), but explicitly
 * exempt conversational turns that cannot possibly benefit from a database
 * lookup. Voice transcription frequently hears "Caye" as "Key" or "Kay",
 * so those aliases must stay in the conversational fast path too.
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

const CAYE_NAME = '(?:caye|key|kay)'
const CONVERSATIONAL_PATTERNS: readonly RegExp[] = [
  /^\s*(hi|hey|hello|yo|sup|wassup|what'?s up|good (morning|afternoon|evening))\b[\s,.!?-]*$/i,
  new RegExp(`^\\s*(hi|hey|hello|yo)[,\\s]+${CAYE_NAME}\\b[\\s,.!?-]*(what'?s up|how are you|you there)?[\\s,.!?-]*$`, 'i'),
  new RegExp(`^\\s*${CAYE_NAME}[,\\s]+(what'?s up|how are you|you there)\\b[\\s,.!?-]*$`, 'i'),
  /^\s*(can you hear me|do you hear me|are you there|you there)\b[\s,.!?-]*$/i,
  /^\s*(thanks|thank you|appreciate it|cool|okay|ok|got it)\b[\s,.!?-]*$/i,
]

/** Leading imperative verb, not a substring match — "draft" mid-sentence about something else shouldn't count. */
const LEADING_TRANSFORM_VERB = /^\s*(please\s+)?(draft|rewrite|reword|edit|polish|proofread|shorten|summarize|summarise|translate|paraphrase|tighten)\b/i

/** Signals the content being transformed is supplied in this same message, not fetched. */
const REFERENCES_INLINE_CONTENT = /[:"']|this (message|sentence|text|reply|note|paragraph)|the following|below/i

function isMetaAboutCaye(text: string): boolean {
  return META_ABOUT_CAYE_PATTERNS.some((p) => p.test(text))
}

function isConversational(text: string): boolean {
  return CONVERSATIONAL_PATTERNS.some((p) => p.test(text))
}

function isPureTransformOfInlineContent(text: string): boolean {
  return LEADING_TRANSFORM_VERB.test(text) && REFERENCES_INLINE_CONTENT.test(text)
}

export function requiresBusinessGrounding(latestUserText: string): boolean {
  const text = latestUserText.trim()
  if (!text) return false
  if (isConversational(text)) return false
  if (isMetaAboutCaye(text)) return false
  if (isPureTransformOfInlineContent(text)) return false
  return true
}
