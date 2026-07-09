import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface HeldRow {
  id: string
  customer_name: string | null
  customer_id: string | null
  channel_type: string
  human_agent_reason: string | null
  human_agent_marked_at: string | null
  last_message_preview: string | null
}

export const getHeldQueue: Tool<Record<string, never>> = {
  name: 'get_held_queue',
  description:
    "Get the current held items needing the operator's call. Each item is a customer thread Caye paused because she wasn't confident enough to reply autonomously. Use this when the operator asks 'anything need my call?' / 'anyone held?' / 'what's pending?'. Each item carries has_open_escalation — true means it already has its own daily nag cadence via escalation-followup, so briefings/recaps should NOT re-describe it in detail or re-propose an action (that's duplicate noise the operator already saw); just fold escalated items into a one-line count. Only items with has_open_escalation=false are new enough to warrant calling out by name.",
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {},
  },

  async execute(_args, ctx) {
    const supabase = createServiceClient()

    const { data: accounts } = await supabase
      .from('connected_accounts')
      .select('id')
      .eq('user_id', ctx.workspaceId)
    const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)
    if (accountIds.length === 0) {
      return { ok: true, data: { items: [], count: 0 } }
    }

    const { data, error } = await supabase
      .from('unified_conversations')
      .select(
        'id, customer_name, customer_id, channel_type, human_agent_reason, human_agent_marked_at, last_message_preview'
      )
      .in('connected_account_id', accountIds)
      .eq('is_archived', false)
      .eq('human_agent_enabled', true)
      .order('human_agent_marked_at', { ascending: true, nullsFirst: false })

    if (error) return { ok: false, error: error.message }

    const rows = (data ?? []) as HeldRow[]
    const conversationIds = rows.map((r) => r.id)

    // Cross-reference caye_escalations so briefings/recaps can tell "brand
    // new hold" from "already being nagged daily via escalation-followup" —
    // without this, get_held_queue re-surfaces the same names the followup
    // cron is separately chasing, and the operator sees the same item
    // described twice through two unrelated channels the same day.
    let openEscalationConvIds = new Set<string>()
    if (conversationIds.length > 0) {
      const { data: escalations } = await supabase
        .from('caye_escalations')
        .select('conversation_id')
        .in('conversation_id', conversationIds)
        .is('owner_responded_at', null)
        .is('expired_at', null)
      openEscalationConvIds = new Set(
        (escalations ?? []).map((e: { conversation_id: string | null }) => e.conversation_id).filter(Boolean) as string[]
      )
    }

    return {
      ok: true,
      data: {
        items: rows.map((r) => ({
          conversation_id: r.id,
          customer: r.customer_name || r.customer_id || 'a customer',
          channel: r.channel_type,
          reason: r.human_agent_reason,
          preview: r.last_message_preview,
          held_at: r.human_agent_marked_at,
          has_open_escalation: openEscalationConvIds.has(r.id),
        })),
        count: rows.length,
      },
    }
  },
}
