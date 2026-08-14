import { decideNextAction, type LeadState, type SalesAction } from './next-action'
import type { SalesStage } from './funnel'

export interface SalesOutreachLeadFacts {
  stage: SalesStage
  firstTouchSentAt: string | null
  touchesSent: number
  lastTouchSentAt: string | null
  optedOutAt: string | null
  inboundKind: LeadState['lastInboundKind']
  outreachDeferredAt: string | null
  disqualifyingSignal: string | null
  conversationLastSenderType?: string | null
}

/** Acquisition-only decision seam; dispatch, claims, and queues remain shared core. */
export function decideSalesOutreachWorkflow(facts: SalesOutreachLeadFacts, now: Date): SalesAction {
  return decideNextAction({
    stage: facts.stage, firstTouchSentAt: facts.firstTouchSentAt, touchesSent: facts.touchesSent,
    lastTouchSentAt: facts.lastTouchSentAt, optedOutAt: facts.optedOutAt,
    hasUnansweredReply: facts.inboundKind === 'human_reply' && facts.conversationLastSenderType === 'customer',
    hasUnclassifiedInbound: !facts.inboundKind && facts.conversationLastSenderType === 'customer',
    lastInboundKind: facts.inboundKind, outreachDeferredAt: facts.outreachDeferredAt,
    disqualifyingSignal: facts.disqualifyingSignal,
  }, now)
}
