/**
 * authority.ts
 *
 * How much rope Caye has for a given sales action.
 *
 * WHY (2026-08-12)
 * Autonomy is not "the model decides". It is a standing grant of authority
 * over a defined class of actions, plus a defined way to ask for more. That
 * is how a real employee works, and it is the only version of this that is
 * both useful and safe.
 *
 * The rule, stated once:
 *
 *   Act when the action is normal, authorised, reversible and understood.
 *   Ask when it is prepared and reasonable but consequential.
 *   Escalate when the judgment genuinely belongs to the founder.
 *
 * Every escalation below is triggered by a deterministic fact. Model
 * uncertainty is retained as audit context, not a generic owner-attention
 * trigger: bounded work continues after deterministic evidence is present.
 *
 * The three tiers map onto plumbing that already exists, which is why this
 * file returns a verdict rather than doing anything:
 *   auto      -> the caller executes now
 *   approval  -> stage into caye_pending_actions (a cron can only ever
 *                stage; confirming requires a real human turn — see
 *                lib/caye-agent/tools/high-risk-gate.ts)
 *   escalate  -> recordEscalation(route_to: 'founder')
 */

import type { EscalationCategory } from './escalation-triggers'
import { decideActionAutonomy, type AutonomyDecision } from '@/lib/action-autonomy'

export type SalesActionKind =
  | 'send_first_touch'
  | 'send_followup'
  | 'reply_to_prospect'
  | 'mark_disqualified'
  | 'mark_cold'
  | 'record_signal'
  | 'propose_new_segment'

export type AuthorityTier = 'auto' | 'approval' | 'escalate'

export interface AuthorityInput {
  action: SalesActionKind
  /** Categories tripped by the prospect's inbound message, if any. */
  triggers?: readonly EscalationCategory[]
  /** Truthfulness/style guards failed on the draft. */
  draftFailedGuards?: boolean
  /** Workspace-level cold-send kill switch is on. */
  outreachPaused?: boolean
  /** Today's send cap is spent. */
  atDailyCap?: boolean
  /** The model said it was unsure. Advisory/audit-only. */
  modelUncertain?: boolean
}

export interface AuthorityVerdict {
  tier: AuthorityTier
  /** Shared deterministic envelope decision retained for audit/observability. */
  decision: AutonomyDecision
  /** Machine-readable, for logs and tests. Never shown to a prospect. */
  reasons: string[]
  /** Present when tier === 'escalate'. */
  escalationCategory?: EscalationCategory
}

/**
 * Actions Caye owns outright. Everything here is reversible, routine, and
 * inside the job description: research, contact, answer, follow up, keep
 * her own records straight, decide someone is not a fit.
 *
 * `mark_disqualified` is deliberately auto. Recognising that a prospect
 * should be left alone is core competence, not a risk — and routing it
 * through Lamar would make the polite thing (stopping) slower than the
 * rude thing (continuing).
 */
const AUTONOMOUS_ACTIONS: readonly SalesActionKind[] = [
  'send_first_touch',
  'send_followup',
  'reply_to_prospect',
  'mark_disqualified',
  'mark_cold',
  'record_signal',
]

/**
 * Prepared, presented, not executed. Expanding who we target is a strategy
 * call with a real blast radius — a bad segment is a week of unreviewed
 * sends into a market nobody vetted — but it is also a perfectly reasonable
 * thing for Caye to propose, so it gets the middle tier rather than a ban.
 */
const APPROVAL_ACTIONS: readonly SalesActionKind[] = ['propose_new_segment']

const SALES_AUTONOMY_POLICY = {
  allowedActions: AUTONOMOUS_ACTIONS,
  // The scan executes one lead at a time. Larger sends must remain an
  // explicitly-reviewed batch until a domain policy deliberately expands it.
  maxExternalRecipients: 1,
  maxRecordsAffected: 1,
  maxFinancialImpactCents: 0,
  auditExternalActions: true,
} as const

export function decideAuthority(input: AuthorityInput): AuthorityVerdict {
  // 1. Escalation categories win over everything. If the prospect raised a
  //    contract, a refund, or the press, no amount of routine-ness makes an
  //    autonomous reply appropriate.
  if (input.triggers?.length) {
    return {
      tier: 'escalate',
      decision: 'require_approval',
      reasons: ['escalation_category_matched'],
      escalationCategory: input.triggers[0],
    }
  }

  // 2. A draft that failed the truthfulness or style guards never sends,
  //    regardless of tier. It becomes something Lamar looks at.
  if (input.draftFailedGuards) {
    return { tier: 'approval', decision: 'require_approval', reasons: ['draft_failed_guards'] }
  }

  // 3. Hard stops on outbound. These do not make the action wrong, only
  //    not-now, so the work is preserved for Lamar rather than dropped.
  const isOutbound =
    input.action === 'send_first_touch' || input.action === 'send_followup'
  if (isOutbound && input.outreachPaused) {
    return { tier: 'approval', decision: 'require_approval', reasons: ['outreach_paused'] }
  }
  if (isOutbound && input.atDailyCap) {
    return { tier: 'approval', decision: 'require_approval', reasons: ['daily_cap_reached'] }
  }

  const actionKnown = AUTONOMOUS_ACTIONS.includes(input.action)
  const envelope = decideActionAutonomy({
    action: input.action,
    reversibility: actionKnown ? 'recoverable' : 'difficult_to_recover',
    evidenceSufficient: actionKnown,
    affectedPeople: input.action === 'send_first_touch' || input.action === 'send_followup' || input.action === 'reply_to_prospect' ? 1 : 0,
    affectedRecords: 1,
    externalCommunication: input.action === 'send_first_touch' || input.action === 'send_followup' || input.action === 'reply_to_prospect',
    ownerRule: APPROVAL_ACTIONS.includes(input.action) ? 'require_approval' : undefined,
    modelUncertain: input.modelUncertain,
  }, SALES_AUTONOMY_POLICY)

  // Model uncertainty is intentionally passed only as audit context. It is
  // not an authority signal: bounded, evidenced work remains autonomous.
  return {
    tier: envelope.decision === 'act' || envelope.decision === 'act_and_audit' || envelope.decision === 'act_within_budget' ? 'auto' : 'approval',
    decision: envelope.decision,
    reasons: actionKnown ? envelope.reasons : ['unclassified_action', ...envelope.reasons],
  }
}

/**
 * Plain sentence for Lamar. No internal vocabulary — no "tier", no
 * "verdict", no reason codes — matching the discipline in
 * lib/caye-agent/evidence.ts's ownerNoteFor and lib/operator-text-guard.ts.
 */
export function founderNoteFor(verdict: AuthorityVerdict, context: string): string {
  if (verdict.tier === 'escalate') {
    return `${context} I stopped and left it for you rather than answering.`
  }
  if (verdict.reasons.includes('draft_failed_guards')) {
    return `${context} I wrote something but it did not pass my own checks, so I did not send it.`
  }
  if (verdict.reasons.includes('outreach_paused')) {
    return `${context} Cold sending is paused, so it is waiting.`
  }
  if (verdict.reasons.includes('daily_cap_reached')) {
    return `${context} That is today's sending limit reached, so it is queued for tomorrow.`
  }
  if (verdict.reasons.includes('model_reported_uncertainty')) {
    return `${context} I was not confident enough to send it on my own.`
  }
  return context
}
