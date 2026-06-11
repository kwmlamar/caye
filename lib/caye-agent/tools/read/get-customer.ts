import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface GetCustomerInput {
  query: string
}

interface ContactRow {
  id: string
  name: string | null
  phone_number: string | null
  email: string | null
  channel_type: string | null
  last_message_at: string | null
  notes: string | null
}

interface ConvRow {
  id: string
  customer_name: string | null
  customer_id: string | null
  channel_type: string
  last_message_at: string | null
  contact_id: string | null
}

interface CustomerMatch {
  source: 'contact' | 'conversation'
  contact_id: string | null
  conversation_id: string | null
  name: string | null
  phone: string | null
  email: string | null
  channel: string | null
  last_seen: string | null
  notes: string | null
}

export const getCustomer: Tool<GetCustomerInput> = {
  name: 'get_customer',
  description:
    'Look up a customer by name, phone, or email. Searches both the contacts profile table AND active conversation threads, since many customers exist only as a thread (no enriched contact row yet). Returns up to 5 matches across both sources.',
  risk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search term — a name, phone number, or email address.',
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

    const [contactsRes, convsRes] = await Promise.all([
      supabase
        .from('contacts')
        .select(
          'id, name, phone_number, email, channel_type, last_message_at, notes'
        )
        .eq('customer_id', ctx.workspaceId)
        .or(`name.ilike.%${q}%,phone_number.ilike.%${q}%,email.ilike.%${q}%`)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(5),
      accountIds.length > 0
        ? supabase
            .from('unified_conversations')
            .select(
              'id, customer_name, customer_id, channel_type, last_message_at, contact_id'
            )
            .in('connected_account_id', accountIds)
            .or(`customer_name.ilike.%${q}%,customer_id.ilike.%${q}%`)
            .order('last_message_at', { ascending: false, nullsFirst: false })
            .limit(5)
        : Promise.resolve({ data: [] as ConvRow[], error: null }),
    ])

    if (contactsRes.error) return { ok: false, error: contactsRes.error.message }

    const seen = new Set<string>()
    const matches: CustomerMatch[] = []

    for (const c of (contactsRes.data ?? []) as ContactRow[]) {
      const key = (c.email || c.phone_number || c.name || '').toLowerCase()
      if (key) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      matches.push({
        source: 'contact',
        contact_id: c.id,
        conversation_id: null,
        name: c.name,
        phone: c.phone_number,
        email: c.email,
        channel: c.channel_type,
        last_seen: c.last_message_at,
        notes: c.notes,
      })
    }

    for (const c of (convsRes.data ?? []) as ConvRow[]) {
      const inferredEmail = c.customer_id?.includes('@') ? c.customer_id : null
      const key = (
        c.customer_name ||
        c.customer_id ||
        ''
      ).toLowerCase()
      if (key) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      matches.push({
        source: 'conversation',
        contact_id: c.contact_id,
        conversation_id: c.id,
        name: c.customer_name,
        phone: null,
        email: inferredEmail,
        channel: c.channel_type,
        last_seen: c.last_message_at,
        notes: null,
      })
    }

    return {
      ok: true,
      data: {
        query: q,
        matches: matches.slice(0, 5),
        count: matches.length,
      },
    }
  },
}
