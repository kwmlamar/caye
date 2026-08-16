/**
 * action-claim-guard.ts
 *
 * Pure text analysis: does this reply claim an external action COMPLETED
 * when nothing that ran this turn actually completed it?
 *
 * WHY THIS EXISTS (2026-08-16 incident)
 * In Caye Direct, asked to bring revenue-recovery opportunities to Mrs. Max
 * over WhatsApp, the model called get_customer, get_team_members, and
 * schedule_reminder, then wrote "Here's what I sent her on WhatsApp just
 * now" and pasted a full message. No tool exists that lets the back-office
 * agent message an operator on Caye's own initiative — schedule_reminder
 * only writes back to the CALLER — so nothing was ever dispatched. Mrs.
 * Max's actual WhatsApp conversation was untouched; the claim was pure
 * text generation with zero backing tool call.
 *
 * Same shape of problem as identity leaks and unverified payment figures
 * (caye-identity-guard.ts, policy-figure-guard.ts): the system prompt
 * already says not to do this, and the model did it anyway, so this is the
 * deterministic code-level backstop — regex over the reply text plus a
 * lookup against what actually executed this turn, not a second model call.
 *
 * 2026-08-16 follow-up: send_operator_message (the capability this incident
 * was actually missing) is in the 'send' rule's groundedBy list below, so a
 * "sent" claim is now believable for a real operator send, not just
 * send_reply/send_payment_confirmation. Nothing about this file is specific
 * to Mrs. Max or Bimini — groundedBy names tools, not people or workspaces.
 *
 * Deliberately scoped to the categories with real incident evidence (send,
 * schedule). Extend RULES for a new completion-claim category; the
 * mechanism itself does not change.
 */

export interface ExecutedToolOutcome {
  name: string
  ok: boolean
  /** True when the tool only staged a high-risk action (gateHighRisk) rather than completing it. */
  pendingOnly?: boolean
}

export interface ActionClaimViolation {
  category: string
  sentence: string
}

interface ClaimRule {
  category: string
  /** Matches an affirmative, first-person, past-tense completion claim. */
  claimPattern: RegExp
  /** Tool names whose successful, non-pending execution this turn grounds the claim. */
  groundedBy: readonly string[]
  correction: string
}

/**
 * Sentence-scoped hedge check, mirrors draft-claims.ts's HEDGE_PATTERN — a
 * future-tense, offer, or permission-asking framing is not a completion
 * claim ("I'll send that", "want me to message her?").
 */
const HEDGE_PATTERN =
  /\b(i'?ll|i will|let me|about to|going to|planning to|i can|i could|i'd like to|want me to|should i|shall i|would you like|can i|will i)\b/i

const RULES: readonly ClaimRule[] = [
  {
    category: 'send',
    claimPattern:
      /\b(?:here'?s|this is)\s+what\s+i(?:'ve| have)?\s+(?:just\s+)?sent\b|\bi(?:'ve| have)\s+(?:just\s+)?(?:sent|messaged|texted|emailed)\b|\bi\s+(?:sent|messaged|texted|emailed)\s+(?:her|him|them|it|that)\b/i,
    groundedBy: [
      'send_reply',
      'send_payment_confirmation',
      'send_outreach_batch',
      'notify_driver',
      'escalate_to_owner',
      'send_operator_message',
    ],
    correction:
      "I have not actually sent anything — I don't have a tool that lets me message an operator directly on my own. Here's the draft, for you to send yourself or ask me to relay a different way:",
  },
  {
    category: 'schedule',
    claimPattern:
      /\bi(?:'ve| have)\s+(?:just\s+)?(?:set|created|scheduled)\s+(?:up\s+)?(?:a\s+)?(?:reminder|follow[- ]?up)\b/i,
    groundedBy: ['schedule_reminder'],
    correction: 'I was not able to actually schedule that reminder — nothing was saved.',
  },
]

/** Splits on sentence boundaries while keeping the original separators (including blank lines) so reconstruction is lossless. */
function splitKeepingSeparators(text: string): string[] {
  return text.split(/((?<=[.!?\n])\s+)/)
}

function isGrounded(rule: ClaimRule, executed: readonly ExecutedToolOutcome[]): boolean {
  return executed.some((t) => rule.groundedBy.includes(t.name) && t.ok && !t.pendingOnly)
}

/**
 * Scans `replyText` sentence by sentence. Any sentence that affirmatively
 * claims a completed action in a category with zero grounding this turn is
 * swapped for that category's honest correction, with original whitespace
 * preserved. Everything else — including genuinely grounded claims and the
 * rest of the message — passes through byte-identical.
 */
export function enforceActionGrounding(
  replyText: string,
  executed: readonly ExecutedToolOutcome[]
): { text: string; violations: ActionClaimViolation[] } {
  const violations: ActionClaimViolation[] = []
  const replacedByCategory = new Set<string>()
  const chunks = splitKeepingSeparators(replyText)

  for (let i = 0; i < chunks.length; i += 2) {
    const chunk = chunks[i]
    if (!chunk) continue
    const trailingWs = /\s*$/.exec(chunk)?.[0] ?? ''
    const core = chunk.slice(0, chunk.length - trailingWs.length)
    if (HEDGE_PATTERN.test(core)) continue

    for (const rule of RULES) {
      if (!rule.claimPattern.test(core)) continue
      if (isGrounded(rule, executed)) continue
      violations.push({ category: rule.category, sentence: core.trim() })
      if (replacedByCategory.has(rule.category)) {
        chunks[i] = trailingWs
      } else {
        replacedByCategory.add(rule.category)
        chunks[i] = rule.correction + trailingWs
      }
      break
    }
  }

  if (violations.length === 0) return { text: replyText, violations }
  return { text: chunks.join('').trim(), violations }
}
