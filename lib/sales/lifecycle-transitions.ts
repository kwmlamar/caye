import { isForwardTransition, isTerminal, type SalesStage } from './funnel'

export type SalesLifecycleEvent =
  | 'first_touch_sent'
  | 'followup_sent'
  | 'human_reply_received'
  | 'automated_reply_received'
  | 'inbound_unknown'
  | 'demo_link_clicked'
  | 'opted_out'
  | 'bounce_or_delivery_failure'
  | 'disqualified'
  | 'marked_cold'
  | 'escalated'

export interface LifecycleLeadSnapshot {
  stage: SalesStage
  first_touch_sent_at: string | null
  touches_sent: number
  opted_out_at: string | null
}

/** Pure mirror of the database transition function; used for regression tests. */
export function transitionForEvent(
  lead: LifecycleLeadSnapshot,
  event: SalesLifecycleEvent,
  at: string,
  reason?: string | null,
): Record<string, unknown> {
  if (isTerminal(lead.stage) && event !== 'opted_out' && event !== 'bounce_or_delivery_failure') return {}
  const forward = (to: SalesStage) => isForwardTransition(lead.stage, to) ? to : lead.stage
  switch (event) {
    case 'first_touch_sent': return lead.first_touch_sent_at ? {} : {
      stage: forward('contacted'), status: 'sent', first_touch_sent_at: at,
      touches_sent: Math.max(1, lead.touches_sent), last_touch_sent_at: at, last_nudge_at: at,
    }
    case 'followup_sent': return {
      stage: forward('contacted'), touches_sent: lead.touches_sent + 1,
      last_touch_sent_at: at, last_nudge_at: at, nudge_count: Math.max(0, lead.touches_sent),
    }
    case 'human_reply_received': return { stage: forward('engaged'), status: 'replied', last_inbound_kind: 'human_reply', outreach_deferred_at: null }
    case 'automated_reply_received': return { last_inbound_kind: 'automated_ooo', outreach_deferred_at: at }
    case 'inbound_unknown': return { last_inbound_kind: 'unknown', outreach_deferred_at: at }
    case 'demo_link_clicked': return { stage: forward('demo_started'), status: 'tried', tried_at: at }
    case 'opted_out': return { stage: 'disqualified', status: 'do_not_contact', opted_out_at: at, last_inbound_kind: 'opt_out', outreach_deferred_at: at }
    case 'bounce_or_delivery_failure': return { stage: 'disqualified', status: 'do_not_contact', disqualified_reason: reason ?? 'bounce_or_delivery_failure', last_inbound_kind: 'bounce_or_delivery_failure', outreach_deferred_at: at }
    case 'disqualified': return { stage: 'disqualified', disqualified_reason: reason ?? 'disqualified' }
    case 'marked_cold': return { stage: 'lost', status: 'cold' }
    case 'escalated': return {}
  }
}
