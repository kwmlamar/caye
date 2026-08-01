import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface HeldConv {
  id: string
  customer_name: string | null
  customer_id: string | null
  channel_type: string
  human_agent_reason: string | null
  human_agent_marked_at: string | null
  metadata: Record<string, unknown> | null
}

interface InternalMsg {
  conversation_id: string
  metadata: Record<string, unknown> | null
  sent_at: string
}

export const getPendingQuotes: Tool<Record<string, never>> = {
  name: 'get_pending_quotes',
  description:
    'List drafts Caye prepared for held customer threads — the quotes/replies AND held first-touch cold-outreach emails (hold_kind \'outreach_first_touch\') waiting on the operator to approve. Subset of the held queue; each item has a proposed reply Caye drafted but did not send. Outreach items also carry subject/email/hold_kind so they can be passed straight into send_outreach_batch once the operator approves a batch. Use when the operator asks "what drafts are waiting?", "anything pending my approval?", or "what\'s in the review tab?".',
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
    if (accountIds.length === 0) return { ok: true, data: { items: [], count: 0 } }

    const { data: convs, error: convErr } = await supabase
      .from('unified_conversations')
      .select(
        'id, customer_name, customer_id, channel_type, human_agent_reason, human_agent_marked_at, metadata'
      )
      .in('connected_account_id', accountIds)
      .eq('is_archived', false)
      .eq('human_agent_enabled', true)
      .order('human_agent_marked_at', { ascending: true, nullsFirst: false })
      .limit(50)
    if (convErr) return { ok: false, error: convErr.message }
    const heldConvs = (convs ?? []) as HeldConv[]
    if (heldConvs.length === 0) return { ok: true, data: { items: [], count: 0 } }

    const proposalByConv = new Map<string, string>()

    // create_outreach_leads stores its draft directly on the conversation's
    // own metadata.proposed_reply (no internal unified_messages row) — seed
    // those first so held first-touch outreach threads show up here too.
    // Without this, outreach drafts were invisible to the review tab.
    for (const c of heldConvs) {
      const proposed = c.metadata?.proposed_reply
      if (typeof proposed === 'string' && proposed.trim().length > 0) {
        proposalByConv.set(c.id, proposed.trim())
      }
    }

    // Find the most recent Caye internal note per conversation that has a
    // proposed_reply in metadata (reply-draft path).
    const { data: msgs } = await supabase
      .from('unified_messages')
      .select('conversation_id, metadata, sent_at')
      .in('conversation_id', heldConvs.map((c) => c.id))
      .eq('is_internal', true)
      .order('sent_at', { ascending: false })

    for (const m of (msgs ?? []) as InternalMsg[]) {
      if (proposalByConv.has(m.conversation_id)) continue
      const proposed = m.metadata?.proposed_reply
      if (typeof proposed === 'string' && proposed.trim().length > 0) {
        proposalByConv.set(m.conversation_id, proposed.trim())
      }
    }

    const items = heldConvs
      .filter((c) => proposalByConv.has(c.id))
      .map((c) => {
        const meta = c.metadata ?? {}
        const holdKind = typeof meta.hold_kind === 'string' ? meta.hold_kind : null
        const subject = typeof meta.subject === 'string' ? meta.subject : null
        return {
          conversation_id: c.id,
          customer: c.customer_name,
          email: c.customer_id,
          channel: c.channel_type,
          reason: c.human_agent_reason,
          held_at: c.human_agent_marked_at,
          proposed_reply: proposalByConv.get(c.id),
          hold_kind: holdKind,
          subject,
        }
      })

    return { ok: true, data: { items, count: items.length } }
  },
}
