/**
 * next-action.ts
 *
 * "Given everything I know about this lead right now, what is the most
 * useful thing I can do next?"
 *
 * WHY (2026-08-12)
 * This replaces lib/nudge-eligibility.ts's decideOutreachLeadAction, which
 * answered a much smaller question — "is a nudge due?" — and could only
 * ever return nudge | mark_cold | none. That shape is a scheduler. It has
 * no way to express "this person replied and is a good fit, answer them",
 * or "this person is clearly not a fit, stop", because those were not
 * things the old system could do.
 *
 * The cadence numbers are carried over unchanged from that file (3 days to
 * touch 2, 7 more to touch 3, cold after 14) — they were deliberately
 * chosen in the 2026-08-12 grill and are not being revisited here.
 *
 * Pure and synchronous on purpose: everything it needs is passed in, so it
 * is exhaustively testable without a database, in the same spirit as
 * evidence.ts and standing-rule-standdown.ts.
 */

import { isTerminal, type SalesStage } from './funnel'
import type { SalesActionKind } from './authority'

/** Days of silence after first touch before touch 2. */
export const FOLLOWUP_1_DAYS = 3
/** Days of silence after touch 2 before touch 3 (the last one). */
export const FOLLOWUP_2_DAYS = 7
/** Days after the final touch before we call it and stop. */
export const COLD_AFTER_DAYS = 14
/** Touches after the first. 3 total. */
export const MAX_FOLLOWUPS = 2

export interface LeadState {
  stage: SalesStage
  firstTouchSentAt: string | null
  /** Touches actually DELIVERED, not merely attempted. */
  touchesSent: number
  lastTouchSentAt: string | null
  optedOutAt: string | null
  /** Unanswered inbound from the prospect waiting for a response. */
  hasUnansweredReply: boolean
  /** ICP check failed — e.g. no stable catalog, or US-mainland. */
  disqualifyingSignal: string | null
}

export type SalesAction =
  | { kind: 'send_first_touch' }
  | { kind: 'send_followup'; touchNumber: 2 | 3 }
  | { kind: 'reply_to_prospect' }
  | { kind: 'mark_disqualified'; reason: string }
  | { kind: 'mark_cold' }
  | { kind: 'do_nothing'; reason: string }

/** Narrowing helper so callers can hand the result straight to decideAuthority. */
export function actionKindOf(action: SalesAction): SalesActionKind | null {
  switch (action.kind) {
    case 'send_first_touch': return 'send_first_touch'
    case 'send_followup': return 'send_followup'
    case 'reply_to_prospect': return 'reply_to_prospect'
    case 'mark_disqualified': return 'mark_disqualified'
    case 'mark_cold': return 'mark_cold'
    case 'do_nothing': return null
  }
}

function daysBetween(fromISO: string, now: Date): number | null {
  const ms = Date.parse(fromISO)
  if (Number.isNaN(ms)) return null
  return (now.getTime() - ms) / (1000 * 60 * 60 * 24)
}

/**
 * Precedence is the design. Reading top to bottom is the policy:
 *
 *   1. Stop conditions beat everything (opt-out, terminal, disqualified).
 *   2. A waiting human beats any scheduled outbound — never send someone
 *      touch 3 while their question sits unanswered.
 *   3. Then the cadence.
 */
export function decideNextAction(lead: LeadState, now: Date): SalesAction {
  if (lead.optedOutAt) {
    return { kind: 'do_nothing', reason: 'opted_out' }
  }

  if (lead.disqualifyingSignal && lead.stage !== 'disqualified') {
    return { kind: 'mark_disqualified', reason: lead.disqualifyingSignal }
  }

  if (isTerminal(lead.stage)) {
    return { kind: 'do_nothing', reason: `terminal_stage:${lead.stage}` }
  }

  // A real person is waiting on us. This outranks the calendar.
  if (lead.hasUnansweredReply) {
    return { kind: 'reply_to_prospect' }
  }

  if (!lead.firstTouchSentAt) {
    return lead.stage === 'sourced'
      ? { kind: 'send_first_touch' }
      : { kind: 'do_nothing', reason: 'awaiting_first_touch_prerequisites' }
  }

  // Someone who opened the demo is mid-consideration. Chasing them with a
  // "did you see my email" is the wrong move, and the tracked click already
  // told us they are alive.
  if (lead.stage === 'demo_started' || lead.stage === 'activated') {
    return { kind: 'do_nothing', reason: 'prospect_in_demo' }
  }

  const anchorISO = lead.lastTouchSentAt ?? lead.firstTouchSentAt
  const daysSilent = daysBetween(anchorISO, now)
  if (daysSilent === null) {
    return { kind: 'do_nothing', reason: 'unparseable_timestamps' }
  }

  if (lead.touchesSent > MAX_FOLLOWUPS) {
    return daysSilent >= COLD_AFTER_DAYS
      ? { kind: 'mark_cold' }
      : { kind: 'do_nothing', reason: 'cadence_complete_awaiting_cold_window' }
  }

  // touchesSent counts DELIVERED touches including the first, so 1 delivered
  // touch means the next one due is touch 2.
  const nextTouch = (lead.touchesSent + 1) as 2 | 3
  if (nextTouch !== 2 && nextTouch !== 3) {
    return { kind: 'do_nothing', reason: 'cadence_complete' }
  }
  const required = nextTouch === 2 ? FOLLOWUP_1_DAYS : FOLLOWUP_2_DAYS

  return daysSilent >= required
    ? { kind: 'send_followup', touchNumber: nextTouch }
    : { kind: 'do_nothing', reason: 'not_yet_due' }
}
