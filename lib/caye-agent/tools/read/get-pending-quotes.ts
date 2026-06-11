import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface HeldConv {
  id: string
  customer_name: string | null
  channel_type: string
  human_agent_reason: string | null
  human_agent_marked_at: string | null
}

interface InternalMsg {
  conversation_id: string
  metadata: Record<string, unknown> | null
  sent_at: string
}

export const getPendingQuotes: Tool<Record<string, never>> = {
  name: 'get_pending_quotes',
  description:
    'List drafts Caye prepared for held customer threads — the quotes and replies waiting on the operator to approve. Subset of the held queue; each item has a proposed reply Caye drafted but did not send. Use when the operator asks "what drafts are waiting?" or "anything pending my approval?".',
  risk: 'read',
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
    if (accountIds.length === 0) return { ok: true, data: { items: [], count: 0 } }

    const { data: convs, error: convErr } = await supabase
      .from('unified_conversations')
      .select(
        'id, customer_name, channel_type, human_agent_reason, human_agent_marked_at'
      )
      .in('connected_account_id', accountIds)
      .eq('is_archived', false)
      .eq('human_agent_enabled', true)
      .order('human_agent_marked_at', { ascending: true, nullsFirst: false })
      .limit(50)
    if (convErr) return { ok: false, error: convErr.message }
    const heldConvs = (convs ?? []) as HeldConv[]
    if (heldConvs.length === 0) return { ok: true, data: { items: [], count: 0 } }

    // Find the most recent Caye internal note per conversation that has a
    // proposed_reply in metadata.
    const { data: msgs } = await supabase
      .from('unified_messages')
      .select('conversation_id, metadata, sent_at')
      .in('conversation_id', heldConvs.map((c) => c.id))
      .eq('is_internal', true)
      .order('sent_at', { ascending: false })

    const proposalByConv = new Map<string, string>()
    for (const m of (msgs ?? []) as InternalMsg[]) {
      if (proposalByConv.has(m.conversation_id)) continue
      const proposed = m.metadata?.proposed_reply
      if (typeof proposed === 'string' && proposed.trim().length > 0) {
        proposalByConv.set(m.conversation_id, proposed.trim())
      }
    }

    const items = heldConvs
      .filter((c) => proposalByConv.has(c.id))
      .map((c) => ({
        conversation_id: c.id,
        customer: c.customer_name,
        channel: c.channel_type,
        reason: c.human_agent_reason,
        held_at: c.human_agent_marked_at,
        proposed_reply: proposalByConv.get(c.id),
      }))

    return { ok: true, data: { items, count: items.length } }
  },
}
