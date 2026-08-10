/**
 * Pure checks on a demo-roleplay reply, split out from lib/caye-demo.ts so
 * they're testable without server-only.
 *
 * Demo mode tells Caye she has no tools. Observed live 2026-08-10: she read
 * that as a *character* limitation rather than a rendering one, decided she
 * therefore couldn't take the booking, and did what a receptionist without
 * booking ability would do — handed the guest off to the owner by name and
 * told them to WhatsApp him at "[your number here]". Both halves of that are
 * failures: the demo exists to show Caye closing the booking herself, and a
 * bracketed placeholder is never something a guest should see.
 *
 * The prompt now forbids both explicitly. These detectors exist because
 * prompt text is not enforcement — they drive one corrective retry and a
 * log line, not a hard block, since a mediocre demo reply still beats no
 * reply at all.
 */

export type DemoReplyLeak = 'placeholder' | 'handoff'

// An unfilled template slot: bracketed text containing at least one letter.
// Guest-facing WhatsApp copy has essentially no legitimate reason to carry
// square brackets, so this stays deliberately broad.
const PLACEHOLDER_RE = /\[[^\]\n]*[a-z][^\]\n]*\]/i

// Only instructions aimed at the guest count. Anchoring to an imperative
// position — sentence start, or after please/just/you can — is what keeps
// "I'll message him to confirm" (Caye doing the work herself, which is
// fine) from tripping the same words as "Please message him yourself".
const IMPERATIVE = "(?:^|[.!?\\n]\\s*|\\b(?:please|just|simply|kindly|then|you can|you should|you'll need to)\\s+)"

// Third party only: "send him these details", "contact the owner". The
// object list is him/her/them/the owner/directly rather than any pronoun
// so "we'll text you the details" and "contact us" stay legitimate.
const THIRD_PARTY = '(?:him|her|them|the owner|the manager|directly)'

// Verb before object — "send him these details on WhatsApp".
const HANDOFF_RE = new RegExp(
  `${IMPERATIVE}(?:whatsapp|message|text|call|contact|email|send|reach out to|get in touch with|speak (?:to|with))\\b[^.!?\\n]{0,50}\\b${THIRD_PARTY}\\b`,
  'i'
)

// Object before verb — "give them a call", "shoot her a message".
const HANDOFF_REVERSED_RE = new RegExp(
  `${IMPERATIVE}(?:give|send|shoot|drop)\\b[^.!?\\n]{0,25}\\b${THIRD_PARTY}\\b[^.!?\\n]{0,25}\\b(?:a call|a message|a text|an email|a ring|a shout)\\b`,
  'i'
)

/**
 * Returns the first leak found in a demo reply, or null if it's clean.
 * Placeholder is checked first — it's the unambiguous one.
 */
export function findDemoReplyLeak(reply: string): DemoReplyLeak | null {
  if (PLACEHOLDER_RE.test(reply)) return 'placeholder'
  if (HANDOFF_RE.test(reply) || HANDOFF_REVERSED_RE.test(reply)) return 'handoff'
  return null
}

/** Corrective nudge appended to the system prompt on the retry. */
export function demoRetryInstruction(leak: DemoReplyLeak): string {
  const specific =
    leak === 'placeholder'
      ? 'Your previous attempt contained a bracketed placeholder like [your number here]. You never have a real phone number, link, or name to fill in, so never write a bracket placeholder at all — say what happens instead.'
      : 'Your previous attempt told the guest to contact the owner themselves. You handle this yourself.'

  return `\n\nRETRY — your last reply was rejected. ${specific} Rewrite it: complete the booking yourself, in character, as though it succeeded, then close with the single "→" line.`
}
