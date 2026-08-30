/**
 * Shared punctuation normalization for text that came from speech.
 *
 * Deliberately dependency-free (no 'server-only') so both the server-side
 * voice fast path (conversational-fast-path.ts) and the request-side
 * grounding classifier (lib/model-router/tool-bridge/
 * business-grounding-classifier.ts) can apply the IDENTICAL normalization
 * before pattern-matching. Those two gates decide, respectively, whether a
 * turn can be answered without touching the control plane at all and
 * whether the model is allowed to answer before executing a tool — so when
 * they disagree about the same utterance, latency is the thing that breaks.
 *
 * 2026-08-30 latency investigation. Both gates matched only the ASCII
 * apostrophe, but OpenAI's transcription models emit the typographic one
 * (U+2019). Measured, reproducible consequence:
 *
 *   "Hey Caye, what's up?"   grounding=false  fastpath="I'm here. What's up?"
 *   "Hey Caye, what's up?"   grounding=true   fastpath=null      <- U+2019
 *
 * The second form is what a real spoken greeting actually looks like by the
 * time it reaches the server, so the most common conversational turn missed
 * the fast path AND tripped requiresGrounding — forcing a full ~46k-token
 * tool-loop round trip (plus a mandatory tool call) to say "I'm here."
 *
 * This normalizes MATCHING INPUT ONLY. It is never persisted and never
 * shown to the founder: the original transcript is what gets written to
 * caye_operator_messages and replayed as history, so Caye still sees
 * exactly what was said, curly punctuation included.
 */

/**
 * Characters Unicode uses for the apostrophe/single-quote role. U+2019
 * (right single quotation mark) is the one transcription models actually
 * emit; the rest are here because they occupy the same slot in text that
 * has been through some other normalizer first, and folding them costs
 * nothing.
 */
const SINGLE_QUOTE_LIKE = /[‘’‚‛′ʼʹ´`]/g
const DOUBLE_QUOTE_LIKE = /[“”„‟″«»]/g
/** En/em dash and friends read as a plain hyphen for matching purposes. */
const DASH_LIKE = /[‐‑‒–—―−]/g
const ELLIPSIS = /…/g
/** Non-breaking and other exotic spaces that STT and copy/paste both produce. */
const SPACE_LIKE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g

/**
 * Fold typographic punctuation to its ASCII equivalent so a pattern written
 * with a plain `'` matches speech-derived text. Idempotent, and a no-op for
 * text that is already ASCII.
 */
export function normalizeSpokenPunctuation(text: string): string {
  return text
    .replace(SINGLE_QUOTE_LIKE, "'")
    .replace(DOUBLE_QUOTE_LIKE, '"')
    .replace(DASH_LIKE, '-')
    .replace(ELLIPSIS, '...')
    .replace(SPACE_LIKE, ' ')
}
