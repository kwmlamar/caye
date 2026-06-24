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
    "Get the current held items needing the operator's call. Each item is a customer thread Caye paused because she wasn't confident enough to reply autonomously. Use this when the operator asks 'anything need my call?' / 'anyone held?' / 'what's pending?'.",
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
        })),
        count: rows.length,
      },
    }
  },
}
