/**
 * Pure text analysis: does this reply claim an external action completed
 * when nothing that ran this turn actually completed it?
 */

export interface ExecutedToolOutcome {
  name: string
  ok: boolean
  /** True when the tool only staged a high-risk action rather than completing it. */
  pendingOnly?: boolean
}

export interface ActionClaimViolation {
  category: string
  sentence: string
}

interface ClaimRule {
  category: string
  claimPattern: RegExp
  groundedBy: readonly string[]
  correction: string
}

const HEDGE_PATTERN =
  /\b(i'?ll|i will|let me|about to|going to|planning to|i can|i could|i'd like to|want me to|should i|shall i|would you like|can i|will i)\b/i

const RULES: readonly ClaimRule[] = [
  {
    category: 'send',
    claimPattern:
      /\b(?:here'?s|this is)\s+what\s+i(?:'ve| have)?\s+(?:just\s+)?sent\b|\bi(?:'m| am|'ve| have)?\s+(?:already\s+|just\s+|earlier\s+|previously\s+)*(?:sent|messaged|texted|emailed)\b/i,
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
    category: 'external-draft',
    // Pam Ott regression, 2026-08-17: a staged draft_in_inbox was reported
    // as "Updated draft is in your inbox" before confirm_pending_action had
    // executed it. Staging is not filing. This catches both Gmail-specific
    // and generic Drafts-folder completion language.
    claimPattern:
      /\b(?:draft(?:ed)?|it|that|reply)\b[\s\S]{0,45}\b(?:is|is now|'s|was|has been)\b[\s\S]{0,35}\b(?:in|into|filed|saved)\b[\s\S]{0,35}\b(?:gmail|e-?mail|mail|inbox|drafts? folder|drafts?)\b|\bi(?:'ve| have)?\s+(?:already\s+|just\s+)?(?:filed|saved|put|created|drafted)\b[\s\S]{0,45}\b(?:gmail|e-?mail|mail|inbox|drafts?)\b/i,
    groundedBy: ['draft_in_inbox'],
    correction:
      "I haven't filed that into your email Drafts yet — it's still waiting for confirmation.",
  },
  {
    category: 'schedule',
    claimPattern:
      /\bi(?:'ve| have)?\s+(?:already\s+|just\s+|earlier\s+|previously\s+)*(?:set|created|scheduled)\s+(?:up\s+)?(?:a\s+)?(?:reminder|follow[- ]?up)\b/i,
    groundedBy: ['schedule_reminder'],
    correction: 'I was not able to actually schedule that reminder — nothing was saved.',
  },
]

function splitKeepingSeparators(text: string): string[] {
  return text.split(/((?<=[.!?\n])\s+)/)
}

function isGrounded(rule: ClaimRule, executed: readonly ExecutedToolOutcome[]): boolean {
  return executed.some((t) => rule.groundedBy.includes(t.name) && t.ok && !t.pendingOnly)
}

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
