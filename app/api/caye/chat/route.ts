import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { syncBookingToCalendar } from '@/lib/calendar-sync'

interface HistoryMessage {
  from: 'user' | 'caye'
  text: string
}

const KNOWN_FIELDS = new Set([
  'system_prompt',
  'tone',
  'never_say',
  'escalation_rules',
  'pricing_info',
  'common_questions',
  'cancellation_policy',
  'voice_profile',
])

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_conversations',
    description:
      'Search the inbox for conversations. Use this whenever the owner asks about recent messages, emails, chats, customer activity, or anything that happened in the inbox. Always call this before saying you don\'t have information.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date_from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format. For "today" use today\'s date.',
        },
        date_to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format. Optional — omit to search up to now.',
        },
        channel: {
          type: 'string',
          enum: ['email', 'whatsapp', 'instagram', 'messenger'],
          description: 'Filter by channel. Optional.',
        },
        status: {
          type: 'string',
          enum: ['open', 'pending', 'resolved'],
          description: 'Filter by conversation status. Optional.',
        },
        held_only: {
          type: 'boolean',
          description: 'If true, only return conversations held for human review.',
        },
        customer_name: {
          type: 'string',
          description: 'Filter by customer name (partial match). Optional.',
        },
        limit: {
          type: 'number',
          description: 'Max results to return. Default 10, max 25.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_conversation_messages',
    description:
      'Get the full message thread for a specific conversation. Use this when the owner asks what was said in a particular thread, wants to see the details, or asks for a follow-up on a conversation from search results.',
    input_schema: {
      type: 'object' as const,
      properties: {
        conversation_id: {
          type: 'string',
          description: 'The conversation ID returned by search_conversations.',
        },
        limit: {
          type: 'number',
          description: 'Max messages to return. Default 20.',
        },
      },
      required: ['conversation_id'],
    },
  },
  {
    name: 'update_config',
    description:
      'Update Caye\'s behavior or business configuration when the owner gives an instruction to change how Caye responds. Use this any time the owner says "don\'t say X", "always mention Y", "change your tone to Z", "add this to your FAQ", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        field: {
          type: 'string',
          enum: ['system_prompt', 'tone', 'never_say', 'escalation_rules', 'pricing_info', 'common_questions', 'cancellation_policy', 'voice_profile'],
          description: 'Which config field to update.',
        },
        action: {
          type: 'string',
          enum: ['replace', 'append'],
          description: 'Replace overwrites the field. Append adds to it.',
        },
        value: {
          type: 'string',
          description: 'The new value or addition.',
        },
        summary: {
          type: 'string',
          description: 'One short sentence describing what changed, in plain language for the owner. e.g. "I\'ll stop mentioning deposit amounts over WhatsApp."',
        },
      },
      required: ['field', 'action', 'value', 'summary'],
    },
  },
  {
    name: 'list_bookings',
    description:
      'List existing bookings on a given date or date range. Use this whenever ' +
      'the owner asks "what\'s on Friday?", "show me next week", or wants to check ' +
      'the schedule before creating a booking.',
    input_schema: {
      type: 'object' as const,
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD.' },
        end_date: {
          type: 'string',
          description: 'YYYY-MM-DD. Omit to query a single day.',
        },
      },
      required: ['start_date'],
    },
  },
  {
    name: 'create_booking',
    description:
      'Create a booking when the owner asks you to. Trust the owner\'s input as ' +
      'the source of truth — don\'t make up missing fields, ask in your reply if ' +
      'something is missing. After it succeeds, confirm the details in plain text.',
    input_schema: {
      type: 'object' as const,
      properties: {
        customer_name: { type: 'string' },
        customer_phone: { type: 'string' },
        customer_email: { type: 'string' },
        booking_date: { type: 'string', description: 'YYYY-MM-DD.' },
        booking_time: { type: 'string', description: '24-hour HH:MM.' },
        number_of_people: { type: 'number' },
        duration_minutes: {
          type: 'number',
          description:
            'Booking length in minutes. Omit when the owner didn\'t say — the service ' +
            'default (or 120 min) will be used.',
        },
        service_id: {
          type: 'string',
          description: 'Service id from the SERVICES list in your system prompt. Omit if none fits.',
        },
        notes: { type: 'string' },
        status: { type: 'string', enum: ['confirmed', 'pending'] },
      },
      required: ['customer_name', 'booking_date', 'booking_time'],
    },
  },
  {
    name: 'cancel_booking',
    description: 'Cancel an existing booking by id. Use list_bookings first if you don\'t know the id.',
    input_schema: {
      type: 'object' as const,
      properties: {
        booking_id: { type: 'string', description: 'UUID of the booking to cancel.' },
      },
      required: ['booking_id'],
    },
    cache_control: { type: 'ephemeral' },
  },
]

type SearchInput = {
  date_from?: string
  date_to?: string
  channel?: string
  status?: string
  held_only?: boolean
  customer_name?: string
  limit?: number
}

type GetMessagesInput = {
  conversation_id: string
  limit?: number
}

type UpdateConfigInput = {
  field: string
  action: 'replace' | 'append'
  value: string
  summary: string
}

type UpdateConfigResult =
  | { success: true; field: string; summary: string; new_value_preview: string }
  | { error: string }

type ListBookingsInput = { start_date: string; end_date?: string }

type CreateBookingInput = {
  customer_name: string
  customer_phone?: string
  customer_email?: string
  booking_date: string
  booking_time: string
  number_of_people?: number
  duration_minutes?: number
  service_id?: string
  notes?: string
  status?: 'confirmed' | 'pending'
}

type CancelBookingInput = { booking_id: string }

interface ServiceRow {
  id: string
  name: string
  duration_minutes: number
  description?: string | null
  is_shared: boolean
  max_capacity: number
}

async function runListBookings(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  input: ListBookingsInput
) {
  const end = input.end_date ?? input.start_date
  const { data, error } = await supabase
    .from('bookings')
    .select(
      'id, customer_name, booking_date, booking_time, number_of_people, status, service:booking_services(name)'
    )
    .eq('user_id', workspaceId)
    .gte('booking_date', input.start_date)
    .lte('booking_date', end)
    .neq('status', 'cancelled')
    .order('booking_date')
    .order('booking_time')

  if (error) return { error: error.message }
  type Row = {
    id: string
    customer_name: string
    booking_date: string
    booking_time: string
    number_of_people: number
    status: string
    service: { name: string }[] | null
  }
  const rows = (data ?? []) as unknown as Row[]
  return {
    bookings: rows.map(r => ({
      id: r.id,
      date: r.booking_date,
      time: r.booking_time.slice(0, 5),
      customer: r.customer_name,
      party_size: r.number_of_people,
      service: r.service?.[0]?.name ?? null,
      status: r.status,
    })),
  }
}

async function runCreateBooking(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  input: CreateBookingInput
) {
  const time = input.booking_time.length === 5 ? `${input.booking_time}:00` : input.booking_time
  const payload = {
    user_id: workspaceId,
    service_id: input.service_id || null,
    customer_name: input.customer_name.trim(),
    customer_phone: input.customer_phone?.trim() || null,
    customer_email: input.customer_email?.trim() || null,
    booking_date: input.booking_date,
    booking_time: time,
    number_of_people:
      input.number_of_people && input.number_of_people > 0 ? input.number_of_people : 1,
    duration_minutes:
      input.duration_minutes && input.duration_minutes > 0 ? input.duration_minutes : null,
    status: input.status ?? 'confirmed',
    notes: input.notes?.trim() || null,
  }
  const { data, error } = await supabase.from('bookings').insert(payload).select('id').single()
  if (error || !data) return { success: false, error: error?.message ?? 'Insert failed' }
  return { success: true, booking_id: data.id }
}

async function runCancelBooking(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  input: CancelBookingInput
) {
  const { data: bk } = await supabase
    .from('bookings')
    .select('id, user_id')
    .eq('id', input.booking_id)
    .maybeSingle()
  if (!bk || bk.user_id !== workspaceId) return { success: false, error: 'Booking not found' }
  const { error } = await supabase
    .from('bookings')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', input.booking_id)
  if (error) return { success: false, error: error.message }
  return { success: true, booking_id: input.booking_id }
}

async function runSearchConversations(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  input: SearchInput
) {
  const { data: accounts } = await supabase
    .from('connected_accounts')
    .select('id')
    .eq('user_id', workspaceId)
    .eq('is_active', true)

  const accountIds = (accounts || []).map((a: { id: string }) => a.id)
  if (accountIds.length === 0) return { conversations: [], total: 0 }

  let query = supabase
    .from('unified_conversations')
    .select('id, customer_name, channel_type, last_message_at, last_message_preview, status, human_agent_enabled, human_agent_reason, unread_count')
    .in('connected_account_id', accountIds)
    .eq('is_archived', false)
    .order('last_message_at', { ascending: false })
    .limit(Math.min(input.limit || 10, 25))

  if (input.date_from) {
    query = query.gte('last_message_at', `${input.date_from}T00:00:00.000Z`)
  }
  if (input.date_to) {
    query = query.lte('last_message_at', `${input.date_to}T23:59:59.999Z`)
  }
  if (input.channel) {
    query = query.eq('channel_type', input.channel)
  }
  if (input.status) {
    query = query.eq('status', input.status)
  }
  if (input.held_only) {
    query = query.eq('human_agent_enabled', true)
  }
  if (input.customer_name) {
    query = query.ilike('customer_name', `%${input.customer_name}%`)
  }

  const { data, error } = await query
  if (error) return { error: error.message }
  return { conversations: data || [], total: (data || []).length }
}

async function runGetConversationMessages(
  supabase: ReturnType<typeof createServiceClient>,
  input: GetMessagesInput
) {
  const { data, error } = await supabase
    .from('unified_messages')
    .select('sender_type, content, sent_at, message_type')
    .eq('conversation_id', input.conversation_id)
    .order('sent_at', { ascending: false })
    .limit(input.limit || 20)

  if (error) return { error: error.message }
  return { messages: ((data || []).reverse()) }
}

async function runUpdateConfig(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  aiConfig: Record<string, unknown> | null,
  input: UpdateConfigInput
): Promise<UpdateConfigResult> {
  const { field, action, value, summary } = input

  if (!KNOWN_FIELDS.has(field)) {
    return { error: `Unknown field: ${field}` }
  }

  if (field === 'voice_profile') {
    let newValue: unknown = value
    if (action === 'append') {
      const existing = aiConfig?.['voice_profile'] as Record<string, unknown> | string | null | undefined
      if (existing && typeof existing === 'object') {
        try {
          const incoming = JSON.parse(value) as Record<string, unknown>
          newValue = { ...existing, ...incoming }
        } catch {
          newValue = value
        }
      } else if (typeof existing === 'string' && existing) {
        newValue = `${existing}\n${value}`
      }
    }

    const { error } = await supabase
      .from('customers')
      .update({ ai_voice_profile: newValue })
      .eq('id', workspaceId)

    if (error) {
      console.error('[caye/chat] voice_profile update failed:', error)
      return { error: error.message }
    }
    const preview = typeof newValue === 'string'
      ? newValue
      : JSON.stringify(newValue)
    return { success: true, field, summary, new_value_preview: preview.slice(0, 2000) }
  }

  let newValue = String(value)
  if (action === 'append') {
    const existing = aiConfig?.[field] as string | null | undefined
    if (existing) newValue = `${existing}\n${newValue}`
  }

  const { error } = await supabase
    .from('workspace_ai_config')
    .upsert(
      {
        workspace_id: workspaceId,
        [field]: newValue,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id' }
    )

  if (error) {
    console.error('[caye/chat] Config update failed:', error)
    return { error: error.message }
  }

  // Readback: re-fetch the row so the model sees the actual stored value, not a hopeful echo.
  const { data: verifyRow } = await supabase
    .from('workspace_ai_config')
    .select(field)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  const stored = (verifyRow as Record<string, unknown> | null)?.[field]
  const preview = typeof stored === 'string' ? stored : JSON.stringify(stored ?? '')
  return { success: true, field, summary, new_value_preview: preview.slice(0, 2000) }
}

function formatServices(services: ServiceRow[]): string {
  if (!services.length) return '(No services configured.)'
  return services
    .map(s => {
      const sharing = s.is_shared
        ? `, shared group tour, capacity ${s.max_capacity}/slot`
        : ', exclusive'
      return `- ${s.name} (${s.duration_minutes} min${sharing}) [id: ${s.id}]`
    })
    .join('\n')
}

function buildSystemPrompt(
  businessName: string,
  services: ServiceRow[],
  existingPrompt?: string | null
): string {
  const today = new Date().toISOString().split('T')[0]
  return `You are Caye, the AI receptionist for ${businessName}. The person talking to you is the business OWNER, not a customer. Today's date is ${today}.

WHO YOU'RE TALKING TO (absolute):
- This is the operator dashboard. The owner is asking you internal questions about THEIR business — pricing structure, what's on file, draft a reply for a customer, etc.
- You are NEVER selling to the owner. Never offer to book a tour for them. Never say "Would you like to book?", "Shall I reserve?", "Ready to confirm?" — those are customer-facing lines and the owner will think you've broken.
- Answer the owner the way an assistant briefs their boss: factual, structured, no upsell, no CTA. End with "Anything else?" or just stop — never with a sales close.
- If the owner asks "how much is X" they want the price structure, not a pitch. Quote the numbers, mention deposit terms if relevant, stop.
- The only time you generate customer-facing language is when the owner explicitly asks you to draft a reply, an email, or a message to a specific customer. Then it's clearly addressed to that customer.

You have four jobs:
1. Answer questions about the inbox — use search_conversations / get_conversation_messages to look up real activity. Never say you don't have access to the inbox.
2. Manage the calendar — use list_bookings, create_booking, and cancel_booking. The owner is the source of truth, so trust their input. If something's missing (e.g. time), ask in your reply rather than guessing.
3. Answer questions about the business, customers, or how you handle things.
4. When the owner gives you information about the business OR tells you to change your behavior, call update_config in THE SAME TURN. Then show the owner what's now stored, in your own words.

HONESTY RULES (absolute — violating these is the worst thing you can do):
- Never say "I'll update", "Let me update", "I'll save that", "I noted that", "Got it, I'll add that to your config", "updating now", or anything similar unless you ALSO emit an update_config tool call in the same turn. Saying it without doing it is lying to the owner.
- Promises of future action are forbidden. Either call the tool this turn or don't claim you will.
- After update_config returns success, your reply MUST quote or paraphrase the new_value_preview the tool returned so the owner can see what's actually stored. Not "done" — show the new state.
- If update_config returns an error, say so plainly and do not claim success.

CAPTURING INFORMATION:
- When the owner pastes a list, catalog, policy, or any block of business info, capture ALL of it. Don't silently drop items that don't fit a clean schema.
- Services with no price ("upon request", "custom", "inquire"), non-tour offerings (transportation, VIP pickup, DMC, partnerships), policies, and general business facts all belong in update_config(field='system_prompt', action='append'). Append the raw content verbatim — future-you will need it.
- Pricing tables specifically go in pricing_info.
- If you don't know which field something belongs in, default to system_prompt.

SERVICES (use these ids when create_booking takes service_id; omit if none fits):
${formatServices(services)}

Keep responses short and conversational. You are texting with your boss, not writing essays.

STYLE RULES (strict):
- Never use emoji of any kind. No 🌴, 🌊, 🏝️, ☀️, 🐚, 🥥, ⛵, 🌺, ✨ — none, ever. Plain text only.
- Never use tropical / island / beach imagery, metaphors, or vibes language. Don't say things like "island time", "paradise", "tropical breeze", "smooth sailing", "let's set sail", "your slice of paradise", "the islands are calling", "ride the wave". Don't lean on weather, palm trees, sand, sun, or sea references for flavor.
- Don't perform a Caribbean persona or accent. You are a competent receptionist; the business happens to be in the Caribbean, but that's the customer's context, not yours.
- Use neutral, professional, slightly warm phrasing — the way a sharp assistant in any city would talk.${existingPrompt ? `\n\nContext about the business:\n${existingPrompt}` : ''}`
}

const MAX_TOOL_ITERATIONS = 5

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { message: string; workspaceId: string; threadId?: string | null; history?: HistoryMessage[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { message, workspaceId } = body
  let { threadId, history = [] } = body
  if (!message || !workspaceId) {
    return NextResponse.json({ error: 'message and workspaceId are required' }, { status: 400 })
  }

  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  if (user.id !== workspaceId) {
    const { data: membership } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  // Thread setup: create if missing, verify ownership otherwise, then load history from DB.
  let threadTitle: string | null = null
  if (threadId) {
    const { data: thread } = await supabase
      .from('caye_threads')
      .select('user_id, title')
      .eq('id', threadId)
      .maybeSingle()
    if (!thread || thread.user_id !== user.id) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 })
    }
    threadTitle = (thread.title as string | null) ?? null

    // Load full history from DB so client-side state can't desync the conversation.
    const { data: prior } = await supabase
      .from('caye_messages')
      .select('role, content')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true })
    history = (prior || []).map(r => ({
      from: r.role === 'caye' ? 'caye' : 'user',
      text: r.content as string,
    }))
  } else {
    const { data: created, error: createErr } = await supabase
      .from('caye_threads')
      .insert({ workspace_id: workspaceId, user_id: user.id })
      .select('id')
      .single()
    if (createErr || !created) {
      return NextResponse.json({ error: 'Could not create thread' }, { status: 500 })
    }
    threadId = created.id
    history = []
  }

  // Set the thread title from the first user message immediately so the sidebar
  // shows it before the (slower) LLM call returns. Truncate to 40 chars.
  if (!threadTitle) {
    threadTitle = message.length > 40 ? message.slice(0, 40) : message
    await supabase
      .from('caye_threads')
      .update({ title: threadTitle, updated_at: new Date().toISOString() })
      .eq('id', threadId)
  }

  // Persist the user's message immediately.
  await supabase.from('caye_messages').insert({
    thread_id: threadId,
    role: 'user',
    content: message,
  })

  // Helper to persist Caye's reply, bump the thread, and return the response.
  const finalize = async (reply: string, extras: {
    cards?: unknown
    configUpdates?: { field: string; summary: string }[]
    bookingId?: string
    cancelledBookingId?: string
  } = {}) => {
    const { data: inserted } = await supabase
      .from('caye_messages')
      .insert({
        thread_id: threadId,
        role: 'caye',
        content: reply,
        cards: extras.cards ?? null,
      })
      .select('id, created_at')
      .single()
    await supabase
      .from('caye_threads')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', threadId)
    return NextResponse.json({
      reply,
      cards: extras.cards,
      threadId,
      messageId: inserted?.id,
      createdAt: inserted?.created_at,
      configUpdates: extras.configUpdates ?? [],
      bookingId: extras.bookingId,
      cancelledBookingId: extras.cancelledBookingId,
    })
  }

  // Intercept suggestion chips and natural language panel triggers for the demo path
  const lowercaseMsg = message.toLowerCase().trim()
  if (lowercaseMsg.includes('bookings came in overnight')) {
    return finalize(
      "Here are the bookings that came in overnight while you were asleep. I've automatically checked your calendar and confirmed both of them.",
      {
        cards: [
          {
            type: 'booking',
            data: {
              id: 'b-mock-1',
              customer_name: 'Marcus Ferreira',
              tour: 'Bimini Snorkeling Tour',
              date: '2026-05-29',
              time: '09:30',
              guests: 4,
              status: 'confirmed'
            }
          },
          {
            type: 'booking',
            data: {
              id: 'b-mock-2',
              customer_name: 'Jessamyn Pyfrom',
              tour: 'Bimini Island Half-Day Tour',
              date: '2026-05-28',
              time: '14:00',
              guests: 2,
              status: 'confirmed'
            }
          }
        ]
      }
    )
  } else if (lowercaseMsg.includes('needs my call')) {
    return finalize(
      "I've held 1 message that needs your call. Sandra Sweeting is asking if we can do a custom full-day charter this Sunday, which is our scheduled day off.",
      {
        cards: [
          {
            type: 'inbox',
            data: [
              {
                id: 'caye-held-mock-1',
                customer_id: 'ssweeting@yahoo.com',
                customer_name: 'Sandra Sweeting',
                channel_type: 'whatsapp',
                preview: "Can you do a custom full-day charter for 6 people this Sunday? Let me know the price.",
                status: 'held',
                last_message_at: new Date().toISOString(),
                unread_count: 1
              }
            ]
          }
        ]
      }
    )
  } else if (lowercaseMsg.includes('draft a reply to the next pending message') || lowercaseMsg.includes('draft a reply')) {
    return finalize(
      "Here is the next pending message from Marvin Cartwright. He is asking about bookings and deposits for a large group. I've drafted a reply for your review.",
      {
        cards: [
          {
            type: 'inbox',
            data: [
              {
                id: 'caye-draft-mock-1',
                customer_id: 'marvin.c@hey.com',
                customer_name: 'Marvin Cartwright',
                channel_type: 'email',
                preview: "Draft response: Hey Marvin! For groups larger than 8, we require a 50% deposit to lock in the charter. Let me know if you would like me to draft a confirmation invoice.",
                status: 'drafted',
                last_message_at: new Date().toISOString(),
                unread_count: 0
              }
            ]
          }
        ]
      }
    )
  } else if (lowercaseMsg.includes('open my inbox') || lowercaseMsg.includes('open inbox') || lowercaseMsg.includes('show my inbox')) {
    return finalize("Opening your inbox →")
  } else if (lowercaseMsg.includes('open my calendar') || lowercaseMsg.includes('open calendar') || lowercaseMsg.includes('show my calendar')) {
    return finalize("Opening your calendar →")
  } else if (
    lowercaseMsg.includes('what do you know about my business') ||
    lowercaseMsg.includes('what do you know about the business') ||
    lowercaseMsg.includes('what have you learned') ||
    lowercaseMsg.includes('what did you learn') ||
    lowercaseMsg.includes('what do you know so far') ||
    lowercaseMsg.includes('what does my business look like to you')
  ) {
    // Read discovery knowledge from workspace_ai_config plus the structured
    // sources (customers, booking_services). Hand it all to Claude and ask
    // for a first-person summary in Caye's voice — never echo the raw
    // system_prompt back to the operator, and never invent a business name.
    const [{ data: configRow }, { data: customerRow }, { data: serviceRows }] = await Promise.all([
      supabase
        .from('workspace_ai_config')
        .select('system_prompt, pricing_info, metadata')
        .eq('workspace_id', workspaceId)
        .maybeSingle(),
      supabase
        .from('customers')
        .select('business_name, timezone')
        .eq('id', workspaceId)
        .maybeSingle(),
      supabase
        .from('booking_services')
        .select('name, duration_minutes, description, is_shared, max_capacity')
        .eq('user_id', workspaceId)
        .eq('active', true)
        .order('name'),
    ])

    const discoveredPrompt = (configRow?.system_prompt as string | null) || ''
    const pricingInfo = (configRow?.pricing_info as string | null) || ''
    const meta = (configRow?.metadata as Record<string, unknown> | null) || {}
    const discoveryStatus = meta.discovery_status as string | undefined
    const businessName = (customerRow?.business_name as string | null) || null
    const services = (serviceRows ?? []) as Array<{
      name: string
      duration_minutes: number
      description: string | null
      is_shared: boolean
      max_capacity: number
    }>

    if (!discoveredPrompt && !pricingInfo && services.length === 0) {
      const notStarted = discoveryStatus === 'no_account' || !discoveryStatus
      return finalize(
        notStarted
          ? "I haven't read your inbox yet — connect your Zoho Mail account first and I'll take a look."
          : "I haven't picked up much yet. Try sending me some emails and I'll start learning from them."
      )
    }

    const servicesBlock = services.length
      ? services.map(s => {
          const sharing = s.is_shared ? `shared, up to ${s.max_capacity}/slot` : 'exclusive'
          const desc = s.description ? ` — ${s.description}` : ''
          return `- ${s.name} (${s.duration_minutes} min, ${sharing})${desc}`
        }).join('\n')
      : '(none configured)'

    const summarizerSystem =
      'You are Caye, summarising what you know about the operator\'s business back to the operator. ' +
      'Rules: first person, plain prose. Do NOT repeat the instructions you were given. ' +
      'Do NOT include any "You are Caye" framing or second-person prompt language. ' +
      'No emoji. No tropical / island metaphors. ' +
      `Refer to the business by its actual name (${businessName ?? 'unknown — use "your business"'}). ` +
      'Never invent a name; if the name is unknown, say "your business". ' +
      'Group your summary into these sections, omitting any with nothing to say: ' +
      '**What you offer**, **Hours**, **Pricing notes**, **Things I\'m still unsure about**. ' +
      'In "Things I\'m still unsure about", do not just list gaps — ask the owner directly for the single most load-bearing missing piece (deposits / payment methods / hours / lead time, whichever is most important and unknown). One concrete question, not a list. ' +
      'End with a single line inviting correction, e.g. "Anything wrong here? Tell me and I\'ll update what I know."'

    const summarizerUser =
      `Here is everything I have on file for this workspace. Summarise it back to the operator in your own voice.\n\n` +
      `BUSINESS NAME: ${businessName ?? '(unknown)'}\n\n` +
      `STRUCTURED SERVICES (from the booking_services table):\n${servicesBlock}\n\n` +
      `PRICING NOTES:\n${pricingInfo || '(none captured)'}\n\n` +
      `DISCOVERY NOTES (extracted from sent emails — may be patchy):\n${discoveredPrompt || '(none yet)'}`

    let summarizerError: string | null = null
    try {
      const summarizer = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const response = await summarizer.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1800,
        system: summarizerSystem,
        messages: [{ role: 'user', content: summarizerUser }],
      })
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text)
        .join('')
        .trim()
      if (text) return finalize(text)
    } catch (err) {
      console.error('[caye/chat] business summary LLM call failed:', err)
      summarizerError = err instanceof Error
        ? `${err.name}: ${err.message}`
        : String(err)
    }

    // Fallback: render a minimal structured summary without the LLM.
    // Includes the discovered system_prompt so appended catalog data (extra services,
    // partnerships, policies) doesn't disappear when the summarizer call fails.
    const parts: string[] = ["Here's what I've got on your business so far:"]
    if (services.length) parts.push(`**Booked services (structured):**\n${servicesBlock}`)
    if (pricingInfo) parts.push(`**Pricing notes:**\n${pricingInfo}`)
    if (discoveredPrompt) parts.push(`**Everything else on file:**\n${discoveredPrompt}`)
    parts.push(`(Summarizer failed — showing raw stored content. Error: ${summarizerError ?? 'unknown'}. Anything wrong here? Tell me and I'll update what I know.)`)
    return finalize(parts.join('\n\n'))
  }


  const [{ data: workspace }, { data: aiConfig }, { data: serviceRows }] = await Promise.all([
    supabase.from('customers').select('business_name').eq('id', workspaceId).maybeSingle(),
    supabase.from('workspace_ai_config').select('*').eq('workspace_id', workspaceId).maybeSingle(),
    supabase
      .from('booking_services')
      .select('id, name, duration_minutes, description, is_shared, max_capacity')
      .eq('user_id', workspaceId)
      .eq('active', true)
      .order('name'),
  ])

  const businessName = workspace?.business_name || 'your business'
  const services = (serviceRows ?? []) as ServiceRow[]
  const systemPrompt = buildSystemPrompt(businessName, services, aiConfig?.system_prompt)

  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.from === 'user' ? 'user' : 'assistant',
    content: m.text,
  }))
  messages.push({ role: 'user', content: message })

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  let reply = ''
  const configUpdates: { field: string; summary: string }[] = []
  let createdBookingId: string | undefined
  let cancelledBookingId: string | undefined

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: TOOLS,
        messages,
      })

      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find((b) => b.type === 'text')
        if (textBlock && textBlock.type === 'text') reply = textBlock.text
        break
      }

      if (response.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content })

        const toolResults: Anthropic.ToolResultBlockParam[] = []

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue

          let result: unknown
          try {
            if (block.name === 'search_conversations') {
              result = await runSearchConversations(supabase, workspaceId, block.input as SearchInput)
            } else if (block.name === 'get_conversation_messages') {
              result = await runGetConversationMessages(supabase, block.input as GetMessagesInput)
            } else if (block.name === 'update_config') {
              const updateResult = await runUpdateConfig(
                supabase,
                workspaceId,
                aiConfig as Record<string, unknown> | null,
                block.input as UpdateConfigInput
              )
              if ('success' in updateResult && updateResult.success) {
                configUpdates.push({ field: updateResult.field, summary: updateResult.summary })
              }
              result = updateResult
            } else if (block.name === 'list_bookings') {
              result = await runListBookings(supabase, workspaceId, block.input as ListBookingsInput)
            } else if (block.name === 'create_booking') {
              const bookingResult = await runCreateBooking(
                supabase,
                workspaceId,
                block.input as CreateBookingInput
              )
              if (bookingResult.success && bookingResult.booking_id) {
                createdBookingId = bookingResult.booking_id
              }
              result = bookingResult
            } else if (block.name === 'cancel_booking') {
              const cancelResult = await runCancelBooking(
                supabase,
                workspaceId,
                block.input as CancelBookingInput
              )
              if (cancelResult.success && cancelResult.booking_id) {
                cancelledBookingId = cancelResult.booking_id
              }
              result = cancelResult
            } else {
              result = { error: `Unknown tool: ${block.name}` }
            }
          } catch (err) {
            result = { error: String(err) }
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          })
        }

        messages.push({ role: 'user', content: toolResults })
        continue
      }

      // Unexpected stop reason — take whatever text we have
      const textBlock = response.content.find((b) => b.type === 'text')
      if (textBlock && textBlock.type === 'text') reply = textBlock.text
      break
    }
  } catch (err) {
    console.error('[caye/chat] Claude error:', err)
    return NextResponse.json({ error: 'AI service error' }, { status: 500 })
  }

  // Fire-and-forget calendar sync for any bookings Caye created/cancelled this turn.
  if (createdBookingId) {
    syncBookingToCalendar(workspaceId, createdBookingId, 'upsert').catch(err =>
      console.error('[caye/chat] Calendar sync (upsert) failed:', err)
    )
  }
  if (cancelledBookingId) {
    syncBookingToCalendar(workspaceId, cancelledBookingId, 'delete').catch(err =>
      console.error('[caye/chat] Calendar sync (delete) failed:', err)
    )
  }

  return finalize(reply, {
    configUpdates,
    bookingId: createdBookingId,
    cancelledBookingId,
  })
}
