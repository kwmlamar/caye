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
  total_messages_sent: number | null
  total_messages_received: number | null
  notes: string | null
}

export const getCustomer: Tool<GetCustomerInput> = {
  name: 'get_customer',
  description:
    'Look up a customer by name, phone, or email. Use when the operator mentions a customer by name or asks to find someone. Returns up to 5 matches.',
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

    const { data, error } = await supabase
      .from('contacts')
      .select(
        'id, name, phone_number, email, channel_type, last_message_at, total_messages_sent, total_messages_received, notes'
      )
      .eq('customer_id', ctx.workspaceId)
      .or(`name.ilike.%${q}%,phone_number.ilike.%${q}%,email.ilike.%${q}%`)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(5)

    if (error) return { ok: false, error: error.message }
    const rows = (data ?? []) as ContactRow[]
    return {
      ok: true,
      data: {
        query: q,
        matches: rows.map((r) => ({
          contact_id: r.id,
          name: r.name,
          phone: r.phone_number,
          email: r.email,
          channel: r.channel_type,
          last_seen: r.last_message_at,
          messages_in: r.total_messages_received,
          messages_out: r.total_messages_sent,
          notes: r.notes,
        })),
        count: rows.length,
      },
    }
  },
}
