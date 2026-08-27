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
 * The same pass also catches a distinct operator-handoff failure: Caye must
 * not ask the owner to create a booking or send an email themselves when
 * Caye has the tools to perform and report that work. This is not a claim
 * grounding problem, so its rule has no successful-tool exception.
 *
 * 2026-08-16 STALE-CLAIM FOLLOW-UP. This function only ever sees CURRENT-
 * TURN evidence (the `executed` array is built live, per call, by
 * execute.ts). It has no memory of its own — which means it is exactly as
 * good at catching a claim that references a HISTORICAL action as it is at
 * catching one about this turn, PROVIDED the caller supplies the right
 * `executed` evidence for whichever turn produced the text being checked.
 * lib/caye-agent/history-grounding.ts is that caller for stored history: it
 * reconstructs `executed` from a past turn's own persisted tool_use/
 * tool_result rows and re-runs this exact function against that past
 * turn's own text, so a fabricated historical claim gets corrected using
 * the SAME rules as a fresh one — no second, weaker heuristic for "old"
 * claims. See that file for why replaying raw stored prose into a new
 * turn's context (without this) let a model treat its own past hallucination
 * as an accomplished fact.
 *
 * 2026-08-26 (CAY-139/CAY-140): two more rules — 'unsupported-infrastructure-
 * claim' and 'unsupported-platform-escalation-claim' — catch a DIFFERENT
 * failure shape than the ones above: not a claim that an action completed,
 * but an invented CAUSE ("the system is down") or an invented escalation to
 * TropiTech's own platform/support side (as opposed to a real business
 * operator, which the 'send' rule already grounds). These are deliberately
 * kept separate rules with narrow destination lists and empty (not
 * draft-specific) corrections — see each rule's own comment for why, and
 * for the review finding (a prior single combined rule wrongly matched
 * legitimate "I've notified the team/founder" claims that a real
 * send_operator_message call actually grounded).
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
  groundedBy?: readonly string[]
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
      /\b(?:here'?s|this is)\s+what\s+i(?:'ve| have)?\s+(?:just\s+)?sent\b|\bi(?:'m| am|'ve| have)?\s+(?:already\s+|just\s+|earlier\s+|previously\s+)*(?:sent|messaged|texted|emailed)\b/i,
    groundedBy: [
      'send_reply',
      'send_payment_confirmation',
      'send_outreach_batch',
      'notify_driver',
      'escalate_to_owner',
      'send_operator_message',
      // Delivery-qualified, not the bare tool name — execute.ts only ever
      // pushes this entry when retrieve_artifact_for_operator's result
      // carried delivery: 'whatsapp' (a real external send). An inline
      // Caye Direct rendering never grounds a "sent" claim this way, even
      // though the same tool ran and succeeded — see execute.ts's comment.
      'retrieve_artifact_for_operator:whatsapp',
    ],
    correction:
      "I have not actually sent anything — I don't have a tool that lets me message an operator directly on my own. Here's the draft, for you to send yourself or ask me to relay a different way:",
  },
  {
    category: 'external-draft',
    claimPattern:
      /\b(?:draft(?:ed)?|it|that|reply)\b[\s\S]{0,45}\b(?:is|is now|['’]s|was|has been)\b[\s\S]{0,35}\b(?:in|into|filed|saved)\b[\s\S]{0,35}\b(?:gmail|e-?mail|mail|inbox|drafts? folder|drafts?)\b|\bi(?:'ve| have)?\s+(?:already\s+|just\s+)?(?:filed|saved|put|created|drafted)\b[\s\S]{0,45}\b(?:gmail|e-?mail|mail|inbox|drafts?)\b|\b(?:drafted|filed|saved|put)\b[\s\S]{0,30}\b(?:in|into)\b[\s\S]{0,30}\b(?:gmail|e-?mail|mail|inbox|drafts?)\b/i,
    groundedBy: ['draft_in_inbox'],
    // Keep the operator focused on the content. The old correction said
    // "I haven't filed that into your email Drafts yet," which leaked an
    // internal safety distinction into normal conversation and produced the
    // exact confusing John Clark exchange seen in production on 2026-08-20.
    correction: "Here's the draft for your review:",
  },
  {
    category: 'schedule',
    claimPattern:
      /\bi(?:'ve| have)?\s+(?:already\s+|just\s+|earlier\s+|previously\s+)*(?:set|created|scheduled)\s+(?:up\s+)?(?:a\s+)?(?:reminder|follow[- ]?up)\b/i,
    groundedBy: ['schedule_reminder'],
    correction: 'I was not able to actually schedule that reminder — nothing was saved.',
  },
  {
    // 2026-08-26 Bimini incident (CAY-139): draft_in_inbox repeatedly failed
    // for Jeff Dworkin's thread, and the reply told Mrs. Max "the staging
    // system is down" / "backend issue" — a specific infra/root-cause claim
    // no tool result that turn actually made. orchestrator.ts's
    // draftInInboxFailureGuidance() now gives the model the true, narrow
    // reason for every draft_in_inbox error_code, so there should be no gap
    // left to improvise into — this rule is the code backstop underneath
    // that in case the model does it anyway. Deliberately narrow: this is
    // ONLY about claiming infrastructure is broken, never about whether a
    // person got messaged (that's the separate 'unsupported-platform-
    // escalation-claim' rule below, and legitimate operator/owner/founder
    // notification claims are the pre-existing 'send' rule's job — this
    // rule must never overlap either). Correction is intentionally EMPTY,
    // not draft-specific prose: enforceActionGrounding is a general-purpose
    // pass with no knowledge of what turn it's running against (a booking
    // turn, a pricing turn, anything), so injecting "I couldn't save the
    // draft..." here would itself be an unsupported claim on any turn that
    // isn't actually a draft-save failure (CAY-140 review finding). The
    // real, turn-accurate failure copy is guidanceFor's job, not this
    // backstop's — this only ever needs to remove the false clause, never
    // manufacture a replacement one.
    category: 'unsupported-infrastructure-claim',
    claimPattern:
      /\b(?:the\s+)?(?:staging\s+)?(?:system|backend|server|platform)\s+(?:is|seems?(?:\s+to\s+be)?|appears?\s+to\s+be|might\s+be|could\s+be)\s+down\b|\bbackend\s+(?:issue|problem|outage|bug)\b|\b(?:system|platform)\s+(?:issue|outage|problem)\b/i,
    correction: '',
  },
  {
    // 2026-08-26 Bimini incident (CAY-139), CAY-140 review correction. The
    // original single rule here also matched generic "notified the team" /
    // "notified the founder" phrasing with no groundedBy exception, which
    // meant a TRUE completed operator notification — send_operator_message
    // actually ran, and the model correctly reported "I've notified the
    // team" — got silently rewritten into a false draft-failure sentence.
    // "The team", "the founder", "the owner", "Mrs. Max", or any named
    // person are all REACHABLE destinations via send_operator_message /
    // escalate_to_owner / notify_driver (see the 'send' rule above, and
    // lib/caye-agent/tools/write-low/send-operator-message.ts's own
    // description: "the owner or founder"). This rule must never touch
    // those claims — grounding for them is the 'send' rule's job.
    //
    // What this rule blocks is narrower and different in kind: an invented
    // claim of escalating to TropiTech / engineering / support / developers
    // — TropiTech's own platform/support side, not a business operator.
    // Audited the full tool registry (lib/caye-agent/tools/registry.ts) for
    // this PR: no tool of any kind can reach that destination today, so
    // unlike 'send' this has no groundedBy — any match is always corrected.
    // If such a tool is ever added, add it to a groundedBy list here rather
    // than widening this destination set.
    category: 'unsupported-platform-escalation-claim',
    claimPattern:
      /\b(?:worth\s+)?(?:flagg?ing|escalat(?:e|ing)|report(?:ing)?|notify(?:ing)?)\b[\s\S]{0,40}\b(?:tropitech|engineering|support|developers?)\b|\b(?:tropitech|engineering|support|developers?)\s+(?:has\s+been|have\s+been|was|were|should\s+be)\s+(?:notified|flagged|informed)\b|\bi(?:'ve| have)?\s+(?:\w+\s+){0,2}(?:flagged|notified|reported|escalated)\b[\s\S]{0,40}\b(?:tropitech|engineering|support|developers?)\b/i,
    correction: '',
  },
  {
    // 2026-08-21 Mrs. Max incident: when a malformed legacy booking made
    // Caye think Jeff had no booking, it told her to create one herself or
    // email him directly. That reverses the product's value proposition.
    // Match both the underlying "system won't send" refusal and the direct
    // delegation wording so a stale version of either message cannot reach
    // the operator transcript.
    category: 'booking-handoff',
    claimPattern:
      /\b(?:i\s+can'?t\s+route around that block|the system\s+won'?t\s+(?:send|route)[^.!?\n]*\bwithout\s+(?:a|the)\s+booking(?:\s+on\s+file)?|(?:you|please|don'?t forget to)\s+(?:(?:need to|can|should|will)\s+)?(?:create|make|add|put)\s+(?:(?:his|her|the|a)\s+)?booking\b|you\s+(?:(?:can|should)\s+)?(?:email|send)\s+(?:him|her|them|the customer)\s+(?:directly|yourself)\b)/i,
    correction:
      'I’ll reconcile or create the booking here first, then I’ll report back. I’ll ask only if a required booking detail is genuinely missing.',
  },
]

/** Splits on sentence boundaries while keeping the original separators (including blank lines) so reconstruction is lossless. */
function splitKeepingSeparators(text: string): string[] {
  return text.split(/((?<=[.!?\n])\s+)/)
}

function isGrounded(rule: ClaimRule, executed: readonly ExecutedToolOutcome[]): boolean {
  return !!rule.groundedBy?.some((name) => executed.some((t) => t.name === name && t.ok && !t.pendingOnly))
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

    for (const rule of RULES) {
      // Future-tense language is harmless for completed-action claims but
      // cannot excuse delegating work back to the operator ("Please create
      // her booking, then I'll send the email").
      if (rule.groundedBy && HEDGE_PATTERN.test(core)) continue
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
