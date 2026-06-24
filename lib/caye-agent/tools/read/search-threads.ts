import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface SearchThreadsInput {
  query: string
}

interface ConvRow {
  id: string
  customer_name: string | null
  customer_id: string | null
  channel_type: string
  human_agent_enabled: boolean
  last_message_preview: string | null
  last_message_at: string | null
}

export const searchThreads: Tool<SearchThreadsInput> = {
  name: 'search_threads',
  description:
    'Search across customer conversation threads by customer name or last-message text. Returns up to 8 matches. Use when the operator vaguely remembers a thread ("the woman who asked about Sunday") and wants to find it. v1 is LIKE-only — semantic search comes later.',
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search term — customer name, phone, or text from a recent message.',
      },
    },
    required: ['query'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()
    const q = args.query.trim()
    if (!q) return { ok: false, error: 'Empty query' }

    const { data: accounts } = await supabase
      .from('connected_accounts')
      .select('id')
      .eq('user_id', ctx.workspaceId)
    const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)
    if (accountIds.length === 0) return { ok: true, data: { matches: [], count: 0 } }

    const { data, error } = await supabase
      .from('unified_conversations')
      .select(
        'id, customer_name, customer_id, channel_type, human_agent_enabled, last_message_preview, last_message_at'
      )
      .in('connected_account_id', accountIds)
      .eq('is_archived', false)
      .or(`customer_name.ilike.%${q}%,last_message_preview.ilike.%${q}%,customer_id.ilike.%${q}%`)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(8)

    if (error) return { ok: false, error: error.message }
    const rows = (data ?? []) as ConvRow[]
    return {
      ok: true,
      data: {
        query: q,
        matches: rows.map((r) => ({
          conversation_id: r.id,
          customer: r.customer_name || r.customer_id || 'unknown',
          channel: r.channel_type,
          held: r.human_agent_enabled,
          preview: r.last_message_preview,
          last_at: r.last_message_at,
        })),
        count: rows.length,
      },
    }
  },
}
