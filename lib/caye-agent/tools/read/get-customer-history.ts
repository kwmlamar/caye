import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import {
  identityFromConversation,
  identityFromField,
  mergeIdentities,
  summarizeReachability,
  type Identity,
} from '../../customer-profile'
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
    "Get a customer's past bookings + the last 10 messages with them. Pass contact_id (richer profile) OR conversation_id (for conversation-only customers without an enriched contact row — the majority on outreach workspaces). Use after a get_customer call: if the match's source was 'contact', pass contact_id; if 'conversation', pass conversation_id. " +
    "`contact.emails` / `contact.phones` carry every address attributable to them with provenance; `contact.relay_only` holds forwarding addresses that reach them but are not their own (a contact-form relay is not their email). `contact.absent` is what we checked for and genuinely do not have — the ONLY basis for saying we don't have it. `contact.not_checked` was not fetched by this call; never report those as missing.",
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
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
    // Every address we can attribute to this customer, from every source.
    // The thread's own channel-native address matters most: on the outreach
    // workspace ZERO threads have a contacts row, so customer_id is the only
    // place an address exists. See ../../customer-profile.ts.
    const identities: (Identity | null)[] = []

    if (!resolvedContactId && args.conversation_id) {
      const { data: accounts } = await supabase
        .from('connected_accounts')
        .select('id')
        .eq('user_id', ctx.workspaceId)
      const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)
      const { data: conv } = await supabase
        .from('unified_conversations')
        .select('id, contact_id, customer_name, customer_id, channel_type, last_message_at')
        .eq('id', args.conversation_id)
        .in('connected_account_id', accountIds)
        .maybeSingle()
      if (!conv) {
        return { ok: false, error: 'Conversation not found in this workspace' }
      }
      resolvedContactId = (conv.contact_id as string | null) ?? null
      conversationCustomerName = (conv.customer_name as string | null) ?? null
      conversationChannel = (conv.channel_type as string | null) ?? null
      identities.push(
        identityFromConversation(
          conversationChannel,
          conv.customer_id as string | null,
          conv.last_message_at as string | null
        )
      )
    }

    // Load contact profile if we have a contact_id. May be null for
    // conversation-only customers.
    let contact: {
      id: string | null
      name: string | null
      notes: string | null
      facts: unknown
    } | null = null
    if (resolvedContactId) {
      const { data: c } = await supabase
        .from('contacts')
        .select('id, name, phone_number, email, notes, ai_contact_facts, last_message_at')
        .eq('id', resolvedContactId)
        .eq('customer_id', ctx.workspaceId)
        .maybeSingle()
      if (c) {
        contact = {
          id: c.id as string,
          name: c.name as string | null,
          notes: c.notes as string | null,
          facts: c.ai_contact_facts,
        }
        // Stored contact fields are additional identities, not replacements —
        // a contacts row can hold an address the thread never used, and vice
        // versa. Both are kept; mergeIdentities collapses exact duplicates.
        const lastSeen = (c.last_message_at as string | null) ?? null
        identities.push(identityFromField('email', c.email as string | null, 'verified', lastSeen))
        identities.push(
          identityFromField('whatsapp', c.phone_number as string | null, 'verified', lastSeen)
        )
      }
    }
    if (!contact) {
      contact = {
        id: null,
        name: conversationCustomerName,
        notes: null,
        facts: null,
      }
    }

    // Gather the addresses from every thread this contact owns. Without this,
    // calling with contact_id (rather than conversation_id) would report
    // absent: ['email'] for a contacts row that has no email while the address
    // sits on the conversation — which is exactly the false negative `absent`
    // exists to make impossible. `absent` is only trustworthy if we really did
    // look everywhere before claiming it.
    if (contact.id) {
      const { data: accounts } = await supabase
        .from('connected_accounts')
        .select('id')
        .eq('user_id', ctx.workspaceId)
      const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)
      if (accountIds.length > 0) {
        const { data: convs } = await supabase
          .from('unified_conversations')
          .select('customer_id, channel_type, last_message_at')
          .eq('contact_id', contact.id)
          .in('connected_account_id', accountIds)
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(20)
        for (const row of (convs ?? []) as {
          customer_id: string | null
          channel_type: string | null
          last_message_at: string | null
        }[]) {
          identities.push(
            identityFromConversation(row.channel_type, row.customer_id, row.last_message_at)
          )
        }
      }
    }

    const reachability = summarizeReachability(mergeIdentities(identities))

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
          // Every address we can attribute to them, with how we know it.
          // `absent` means we looked everywhere and it genuinely isn't
          // recorded — that is the ONLY basis for telling the operator we
          // don't have something.
          emails: reachability.emails,
          phones: reachability.phones,
          relay_only: reachability.relay_only,
          absent: reachability.absent,
          not_checked: reachability.not_checked,
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
