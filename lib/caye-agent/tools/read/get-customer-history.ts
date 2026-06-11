import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import {
  bookingRevenue,
  BOOKING_WITH_SERVICE_PRICE_SELECT,
  type ServiceJoin,
} from '../_revenue'

interface GetCustomerHistoryInput {
  contact_id?: string
  conversation_id?: string
}

interface BookingRow {
  booking_date: string
  booking_time: string | null
  status: string
  number_of_people: number | null
  service: ServiceJoin[] | null
}

interface MessageRow {
  content: string | null
  sender_type: string | null
  sent_at: string
  channel_type: string | null
}

export const getCustomerHistory: Tool<GetCustomerHistoryInput> = {
  name: 'get_customer_history',
  description:
    "Get a customer's past bookings + the last 10 messages with them. Pass contact_id (richer profile) OR conversation_id (for conversation-only customers without an enriched contact row — common in Bimini's data). Use after a get_customer call: if the match's source was 'contact', pass contact_id; if 'conversation', pass conversation_id.",
  risk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      contact_id: {
        type: 'string',
        description: 'The contact_id from a get_customer match where source=contact. Pass this OR conversation_id, not both.',
      },
      conversation_id: {
        type: 'string',
        description: 'The conversation_id from a get_customer match where source=conversation. Use when the customer exists only as a thread with no enriched contact profile.',
      },
    },
  },

  async execute(args, ctx) {
    if (!args.contact_id && !args.conversation_id) {
      return { ok: false, error: 'Provide contact_id or conversation_id' }
    }
    const supabase = createServiceClient()

    // Resolve contact_id from conversation_id if necessary.
    let resolvedContactId = args.contact_id ?? null
    let conversationCustomerName: string | null = null
    let conversationChannel: string | null = null

    if (!resolvedContactId && args.conversation_id) {
      const { data: accounts } = await supabase
        .from('connected_accounts')
        .select('id')
        .eq('user_id', ctx.workspaceId)
      const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)
      const { data: conv } = await supabase
        .from('unified_conversations')
        .select('id, contact_id, customer_name, customer_id, channel_type')
        .eq('id', args.conversation_id)
        .in('connected_account_id', accountIds)
        .maybeSingle()
      if (!conv) {
        return { ok: false, error: 'Conversation not found in this workspace' }
      }
      resolvedContactId = (conv.contact_id as string | null) ?? null
      conversationCustomerName = (conv.customer_name as string | null) ?? null
      conversationChannel = (conv.channel_type as string | null) ?? null
    }

    // Load contact profile if we have a contact_id. May be null for
    // conversation-only customers.
    let contact: {
      id: string | null
      name: string | null
      phone: string | null
      email: string | null
      notes: string | null
      facts: unknown
    } | null = null
    if (resolvedContactId) {
      const { data: c } = await supabase
        .from('contacts')
        .select('id, name, phone_number, email, notes, ai_contact_facts')
        .eq('id', resolvedContactId)
        .eq('customer_id', ctx.workspaceId)
        .maybeSingle()
      if (c) {
        contact = {
          id: c.id as string,
          name: c.name as string | null,
          phone: c.phone_number as string | null,
          email: c.email as string | null,
          notes: c.notes as string | null,
          facts: c.ai_contact_facts,
        }
      }
    }
    if (!contact) {
      contact = {
        id: null,
        name: conversationCustomerName,
        phone: null,
        email: null,
        notes: null,
        facts: null,
      }
    }

    // Bookings: only when we have a real contact_id (booking schema joins
    // through contact_id, not conversation).
    let bookingRows: BookingRow[] = []
    if (contact.id) {
      const { data: bookings } = await supabase
        .from('bookings')
        .select(
          `booking_date, booking_time, status, number_of_people, ${BOOKING_WITH_SERVICE_PRICE_SELECT}`
        )
        .eq('user_id', ctx.workspaceId)
        .eq('contact_id', contact.id)
        .order('booking_date', { ascending: false })
        .limit(10)
      bookingRows = (bookings ?? []) as unknown as BookingRow[]
    }

    // Messages: prefer contact_id (covers all their threads). Fall back to
    // the explicit conversation_id when contact_id is missing.
    let messages: { content: string | null; sender_type: string | null; sent_at: string; channel_type: string | null }[] = []
    if (contact.id) {
      const { data } = await supabase
        .from('unified_messages')
        .select(
          'content, sender_type, sent_at, conversation:unified_conversations!inner(channel_type, contact_id)'
        )
        .eq('conversation.contact_id', contact.id)
        .eq('is_internal', false)
        .order('sent_at', { ascending: false })
        .limit(10)
      type Row = MessageRow & {
        conversation: { channel_type: string } | { channel_type: string }[] | null
      }
      messages = ((data ?? []) as unknown as Row[]).map((r) => ({
        content: r.content,
        sender_type: r.sender_type,
        sent_at: r.sent_at,
        channel_type: Array.isArray(r.conversation)
          ? r.conversation[0]?.channel_type ?? null
          : r.conversation?.channel_type ?? null,
      }))
    } else if (args.conversation_id) {
      const { data } = await supabase
        .from('unified_messages')
        .select('content, sender_type, sent_at')
        .eq('conversation_id', args.conversation_id)
        .eq('is_internal', false)
        .order('sent_at', { ascending: false })
        .limit(10)
      type Row = MessageRow
      messages = ((data ?? []) as unknown as Row[]).map((r) => ({
        content: r.content,
        sender_type: r.sender_type,
        sent_at: r.sent_at,
        channel_type: conversationChannel,
      }))
    }
    const messageRows = messages
      .map((m) => ({
        text: m.content,
        from: m.sender_type === 'customer' ? 'customer' : 'business',
        sent_at: m.sent_at,
        channel: m.channel_type,
      }))
      .reverse()

    return {
      ok: true,
      data: {
        contact: {
          contact_id: contact.id,
          name: contact.name,
          phone: contact.phone,
          email: contact.email,
          notes: contact.notes,
          facts: contact.facts,
          has_full_profile: contact.id !== null,
        },
        bookings: bookingRows.map((b) => ({
          date: b.booking_date,
          time: b.booking_time?.slice(0, 5) ?? null,
          status: b.status,
          guests: b.number_of_people,
          price: bookingRevenue({
            servicePrice: b.service?.[0]?.price,
            priceType: b.service?.[0]?.price_type,
            guests: b.number_of_people,
          }),
          service: b.service?.[0]?.name ?? null,
        })),
        recent_messages: messageRows,
      },
    }
  },
}
