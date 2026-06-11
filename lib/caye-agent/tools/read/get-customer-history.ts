import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import {
  bookingRevenue,
  BOOKING_WITH_SERVICE_PRICE_SELECT,
  type ServiceJoin,
} from '../_revenue'

interface GetCustomerHistoryInput {
  contact_id: string
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
    "Get a customer's past bookings + the last 10 messages with them. Use after a get_customer call when the operator wants more context on a specific person, or when handling a held item.",
  risk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      contact_id: {
        type: 'string',
        description: 'The contact_id returned from get_customer.',
      },
    },
    required: ['contact_id'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()

    const { data: contact } = await supabase
      .from('contacts')
      .select('id, name, phone_number, email, notes, ai_contact_facts')
      .eq('id', args.contact_id)
      .eq('customer_id', ctx.workspaceId)
      .maybeSingle()
    if (!contact) return { ok: false, error: 'Contact not found' }

    const { data: bookings } = await supabase
      .from('bookings')
      .select(
        `booking_date, booking_time, status, number_of_people, ${BOOKING_WITH_SERVICE_PRICE_SELECT}`
      )
      .eq('user_id', ctx.workspaceId)
      .eq('contact_id', args.contact_id)
      .order('booking_date', { ascending: false })
      .limit(10)
    const bookingRows = (bookings ?? []) as unknown as BookingRow[]

    const { data: messages } = await supabase
      .from('unified_messages')
      .select(
        'content, sender_type, sent_at, conversation:unified_conversations!inner(channel_type, contact_id)'
      )
      .eq('conversation.contact_id', args.contact_id)
      .eq('is_internal', false)
      .order('sent_at', { ascending: false })
      .limit(10)
    type Row = MessageRow & {
      conversation: { channel_type: string } | { channel_type: string }[] | null
    }
    const messageRows = ((messages ?? []) as unknown as Row[])
      .map((r) => ({
        text: r.content,
        from: r.sender_type === 'customer' ? 'customer' : 'business',
        sent_at: r.sent_at,
        channel: Array.isArray(r.conversation)
          ? r.conversation[0]?.channel_type
          : r.conversation?.channel_type,
      }))
      .reverse()

    return {
      ok: true,
      data: {
        contact: {
          contact_id: contact.id,
          name: contact.name,
          phone: contact.phone_number,
          email: contact.email,
          notes: contact.notes,
          facts: contact.ai_contact_facts,
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
