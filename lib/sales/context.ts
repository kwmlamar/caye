import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { decideNextAction, type SalesAction } from './next-action'
import { recentSignalsFor, renderSignalsBlock, type LeadSignal } from './signals'
import type { SalesStage } from './funnel'

export interface SalesLeadContext {
  id: string
  stage: SalesStage
  businessName: string | null
  touchCount: number
  inboundKind: 'human_reply' | 'automated_ooo' | 'opt_out' | 'bounce_or_delivery_failure' | 'unknown' | null
  nextAction: SalesAction
  signals: LeadSignal[]
  promptMemory: string
}

/** Existing acquisition facts assembled in one Sales-owned seam. */
export async function buildSalesLeadContext(input: {
  workspaceId: string
  leadId: string
  conversationLastSenderType?: string | null
}): Promise<SalesLeadContext | null> {
  const supabase = createServiceClient()
  const { data } = await supabase.from('outreach_leads')
    .select('id, stage, business_name, first_touch_sent_at, touches_sent, last_touch_sent_at, opted_out_at, last_inbound_kind, outreach_deferred_at, disqualified_reason')
    .eq('id', input.leadId).eq('workspace_id', input.workspaceId).maybeSingle()
  if (!data) return null
  const lead = data as {
    id: string; stage: SalesStage; business_name: string | null; first_touch_sent_at: string | null
    touches_sent: number; last_touch_sent_at: string | null; opted_out_at: string | null
    last_inbound_kind: SalesLeadContext['inboundKind']; outreach_deferred_at: string | null; disqualified_reason: string | null
  }
  const signals = await recentSignalsFor(lead.id)
  const nextAction = decideNextAction({
    stage: lead.stage, firstTouchSentAt: lead.first_touch_sent_at, touchesSent: lead.touches_sent,
    lastTouchSentAt: lead.last_touch_sent_at, optedOutAt: lead.opted_out_at,
    hasUnansweredReply: lead.last_inbound_kind === 'human_reply' && input.conversationLastSenderType === 'customer',
    hasUnclassifiedInbound: !lead.last_inbound_kind && input.conversationLastSenderType === 'customer',
    lastInboundKind: lead.last_inbound_kind, outreachDeferredAt: lead.outreach_deferred_at,
    disqualifyingSignal: lead.disqualified_reason,
  }, new Date())
  const header = `Where this prospect stands: ${lead.stage}${lead.business_name ? ` (${lead.business_name})` : ''}.`
  const signalBlock = renderSignalsBlock(signals)
  return {
    id: lead.id, stage: lead.stage, businessName: lead.business_name, touchCount: lead.touches_sent,
    inboundKind: lead.last_inbound_kind, nextAction, signals,
    promptMemory: signalBlock ? `${header}\n${signalBlock}` : header,
  }
}
