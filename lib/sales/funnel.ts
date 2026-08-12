/**
 * funnel.ts
 *
 * The objective Caye owns on the internal_sales workspace, expressed as
 * state rather than prose.
 *
 * WHY (2026-08-12)
 * Before this, a lead's `outreach_leads.status` mixed three different
 * things: where the lead is in the relationship ('sent', 'replied'), what
 * artefact exists ('draft'), and why we stopped ('cold', 'do_not_contact').
 * Nothing represented progress toward a customer, so nothing could reason
 * about it — the system's terminal state was "email sent", which is not a
 * business outcome. Two of the values that WOULD have represented success,
 * 'replied' and 'converted', were never written by any code.
 *
 * A stage is "where is this relationship", full stop. Artefact state lives
 * on the conversation, and the reason we stopped lives in
 * `disqualified_reason`. One question per column.
 *
 * This file is the single source of truth for the vocabulary. The DB CHECK
 * constraint is asserted against SALES_STAGES by funnel.test.ts, so a stage
 * added here without a migration fails the suite rather than silently
 * writing a value the database rejects at 3am.
 */

/**
 * Ordered by progress toward the objective. Order is meaningful:
 * `isForwardTransition` uses it, and reporting sorts by it.
 */
export const SALES_STAGES = [
  /** Sourced, never contacted. */
  'sourced',
  /** First touch delivered, no response yet. */
  'contacted',
  /** They replied. A human is now paying attention to us. */
  'engaged',
  /** Replied AND they look like a real fit (see ICP disqualifiers). */
  'qualified',
  /** They opened the demo. */
  'demo_started',
  /** They got through the demo and saw Caye work. */
  'activated',
  /** Paying. */
  'won',
  /** They said no, or went silent through the full cadence. */
  'lost',
  /** Not a fit, and we stopped on purpose. Distinct from 'lost' — this is
   *  our call, not theirs, and it is not a failure to feel bad about. */
  'disqualified',
] as const

export type SalesStage = (typeof SALES_STAGES)[number]

/** Stages where Caye should stop initiating contact, for any reason. */
export const TERMINAL_STAGES: readonly SalesStage[] = ['won', 'lost', 'disqualified']

export function isTerminal(stage: SalesStage): boolean {
  return TERMINAL_STAGES.includes(stage)
}

export function stageRank(stage: SalesStage): number {
  return SALES_STAGES.indexOf(stage)
}

/**
 * True when `to` is further along than `from`.
 *
 * Deliberately permissive about skipping: a prospect can reply to a first
 * touch already saying "yes I want this", which jumps contacted → qualified
 * in one message. Real funnels skip steps; a state machine that refuses to
 * would just make Caye record something false.
 *
 * Backward moves are rejected, with one exception handled by the caller:
 * a lead can always move to a terminal stage from anywhere (they can say
 * no at any point).
 */
export function isForwardTransition(from: SalesStage, to: SalesStage): boolean {
  if (from === to) return false
  if (isTerminal(to)) return true
  return stageRank(to) > stageRank(from)
}

/**
 * The stage a lead is in, derived from observable facts rather than trusted
 * from a column that some other code path may have forgotten to update.
 *
 * Precedence runs strongest-evidence-first: an explicit opt-out beats
 * everything, and money beats behaviour beats a timestamp. Anything the
 * caller cannot establish should be passed as false/null rather than
 * guessed — this function is meant to be boring and checkable.
 */
export interface StageEvidence {
  optedOut: boolean
  disqualified: boolean
  isPaying: boolean
  /** Completed the demo conversation, not merely clicked. */
  demoCompleted: boolean
  /** Clicked the tracked link. */
  demoOpened: boolean
  /** Passed ICP qualification during a conversation. */
  qualified: boolean
  /** Any inbound message from them, ever. */
  hasReplied: boolean
  /** First touch actually delivered. */
  contacted: boolean
  /** Cadence exhausted with no reply. */
  cadenceExhausted: boolean
}

export function deriveStage(e: StageEvidence): SalesStage {
  if (e.disqualified) return 'disqualified'
  // An opt-out from someone who never engaged is a disqualification in
  // everything but name; from someone who did, it is a loss. Either way we
  // stop, so the distinction only matters for honest reporting.
  if (e.optedOut) return e.hasReplied ? 'lost' : 'disqualified'
  if (e.isPaying) return 'won'
  if (e.demoCompleted) return 'activated'
  if (e.demoOpened) return 'demo_started'
  if (e.qualified) return 'qualified'
  if (e.hasReplied) return 'engaged'
  if (e.cadenceExhausted) return 'lost'
  if (e.contacted) return 'contacted'
  return 'sourced'
}
