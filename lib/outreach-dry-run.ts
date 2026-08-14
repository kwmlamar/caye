import 'server-only'
import { createServiceClient } from './supabase-server'
import type { SalesAction } from './sales/next-action'
import { decideSalesOutreachWorkflow } from './sales/outreach-workflow'
import { selectOutreachBatch } from './outreach-batch'
import type { SalesStage } from './sales/funnel'
import { isValidOutreachEmail } from './outreach-email'

interface Row {
  id: string; lead_email: string; business_name: string | null; stage: SalesStage; created_at: string
  first_touch_sent_at: string | null; touches_sent: number; last_touch_sent_at: string | null
  opted_out_at: string | null; disqualified_reason: string | null
  last_inbound_kind: 'human_reply' | 'automated_ooo' | 'opt_out' | 'bounce_or_delivery_failure' | 'unknown' | null
  outreach_deferred_at: string | null
}

export interface OutreachDryRun {
  considered: number
  selected: Array<{ id: string; email: string; business: string | null; action: SalesAction; category: 'fresh' | 'cadence' }>
  excluded: Record<string, number>
}

export async function dryRunOutreachSelection(workspaceId: string, now = new Date(), limit = 40): Promise<OutreachDryRun> {
  const db = createServiceClient()
  const { data: account } = await db.from('connected_accounts').select('id').eq('user_id', workspaceId).eq('channel_type', 'email').eq('is_active', true).maybeSingle()
  if (!account) return { considered: 0, selected: [], excluded: { no_active_sender: 1 } }
  const { data, error } = await db.from('outreach_leads').select('id,lead_email,business_name,stage,created_at,first_touch_sent_at,touches_sent,last_touch_sent_at,opted_out_at,disqualified_reason,last_inbound_kind,outreach_deferred_at').eq('workspace_id', workspaceId).not('stage', 'in', '("won","lost","disqualified")').is('outreach_claim_token', null).order('created_at')
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Row[]
  const { data: conversations } = rows.length ? await db.from('unified_conversations').select('customer_id,metadata,last_sender_type,human_agent_enabled').eq('connected_account_id', account.id).eq('channel_type', 'email').in('customer_id', rows.map((row) => row.lead_email)) : { data: [] }
  const byEmail = new Map((conversations ?? []).map((row) => [String(row.customer_id).toLowerCase(), row]))
  const excluded: Record<string, number> = {}
  const plans = rows.flatMap((row) => {
    if (!isValidOutreachEmail(row.lead_email)) { excluded.invalid_email = (excluded.invalid_email ?? 0) + 1; return [] }
    const conversation = byEmail.get(row.lead_email.toLowerCase())
    const metadata = (conversation?.metadata ?? {}) as Record<string, unknown>
    if (conversation?.human_agent_enabled === true && typeof metadata.proposed_reply === 'string' && conversation.last_sender_type !== 'customer') {
      excluded.parked_draft = (excluded.parked_draft ?? 0) + 1; return []
    }
    const action = decideSalesOutreachWorkflow({ stage: row.stage, firstTouchSentAt: row.first_touch_sent_at, touchesSent: row.touches_sent, lastTouchSentAt: row.last_touch_sent_at, optedOutAt: row.opted_out_at, inboundKind: row.last_inbound_kind, outreachDeferredAt: row.outreach_deferred_at, disqualifyingSignal: row.disqualified_reason, conversationLastSenderType: conversation?.last_sender_type }, now)
    if (action.kind === 'do_nothing') { excluded[action.reason] = (excluded[action.reason] ?? 0) + 1; return [] }
    return [{ ...row, action }]
  })
  return {
    considered: rows.length,
    selected: selectOutreachBatch(plans, limit).map((row) => ({ id: row.id, email: row.lead_email, business: row.business_name, action: row.action, category: row.first_touch_sent_at ? 'cadence' : 'fresh' })),
    excluded,
  }
}
