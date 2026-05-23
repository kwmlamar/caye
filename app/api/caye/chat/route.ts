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
  | { success: true; field: string; summary: string }
  | { error: string }

type ListBookingsInput = { start_date: string; end_date?: string }

type CreateBookingInput = {
  customer_name: string
  customer_phone?: string
  customer_email?: string
  booking_date: string
  booking_time: string
  number_of_people?: number
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
    return { success: true, field, summary }
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
  return { success: true, field, summary }
}

function formatServices(services: ServiceRow[]): string {
  if (!services.length) return '(No services configured.)'
  return services
    .map(s => `- ${s.name} (${s.duration_minutes} min) [id: ${s.id}]`)
    .join('\n')
}

function buildSystemPrompt(
  businessName: string,
  services: ServiceRow[],
  existingPrompt?: string | null
): string {
  const today = new Date().toISOString().split('T')[0]
  return `You are Caye, the AI receptionist for ${businessName}. The person talking to you is the business owner. Today's date is ${today}.

You have four jobs:
1. Answer questions about the inbox — use search_conversations / get_conversation_messages to look up real activity. Never say you don't have access to the inbox.
2. Manage the calendar — use list_bookings, create_booking, and cancel_booking. The owner is the source of truth, so trust their input. If something's missing (e.g. time), ask in your reply rather than guessing.
3. Answer questions about the business, customers, or how you handle things.
4. When the owner tells you to change your behavior, use update_config immediately. Confirm casually what you changed.

SERVICES (use these ids when create_booking takes service_id; omit if none fits):
${formatServices(services)}

Keep responses short and conversational. You are texting with your boss, not writing essays.${existingPrompt ? `\n\nContext about the business:\n${existingPrompt}` : ''}`
}

const MAX_TOOL_ITERATIONS = 5

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { message: string; workspaceId: string; history?: HistoryMessage[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { message, workspaceId, history = [] } = body
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

  const [{ data: workspace }, { data: aiConfig }, { data: serviceRows }] = await Promise.all([
    supabase.from('customers').select('business_name').eq('id', workspaceId).maybeSingle(),
    supabase.from('workspace_ai_config').select('*').eq('workspace_id', workspaceId).maybeSingle(),
    supabase
      .from('booking_services')
      .select('id, name, duration_minutes, description')
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
        max_tokens: 1024,
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

  return NextResponse.json({
    reply,
    configUpdates,
    bookingId: createdBookingId,
    cancelledBookingId,
  })
}
