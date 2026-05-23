/**
 * POST /api/calendar/ask-caye
 *
 * Owner-facing chat endpoint for the calendar's "Ask Caye" panel.
 * Reuses generateCayeAutoReply with a synthetic conversation context so the
 * owner can do natural-language ops: "book Jane Doe tomorrow at 2pm for 4",
 * "what's on Friday?", etc.
 *
 * Body: { messages: Array<{ role: 'user' | 'assistant'; content: string }> }
 *
 * Returns: { reply: string; booking_id?: string; held?: { reason: string; note: string } }
 */

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import { syncBookingToCalendar } from '@/lib/calendar-sync'

const MAX_TOOL_ROUNDS = 6

interface ServiceRow {
  id: string
  name: string
  duration_minutes: number
  description?: string | null
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_bookings',
    description:
      'List existing bookings on a given date or date range. Use this to answer ' +
      'questions like "what\'s on Friday?" or to check before creating.',
    input_schema: {
      type: 'object' as const,
      properties: {
        start_date: { type: 'string', description: 'Range start (YYYY-MM-DD).' },
        end_date: {
          type: 'string',
          description: 'Range end (YYYY-MM-DD). If omitted, only start_date is queried.',
        },
      },
      required: ['start_date'],
    },
  },
  {
    name: 'create_booking',
    description:
      'Create a booking for the owner. Use the data the owner provides verbatim; ' +
      'ask for what\'s missing in send_reply instead of guessing. Then send_reply ' +
      'with a short confirmation that includes the date/time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        customer_name: { type: 'string' },
        customer_phone: { type: 'string' },
        customer_email: { type: 'string' },
        booking_date: { type: 'string', description: 'YYYY-MM-DD.' },
        booking_time: { type: 'string', description: '24-hour HH:MM.' },
        number_of_people: { type: 'number' },
        service_id: { type: 'string', description: 'From the services list. Omit if none.' },
        notes: { type: 'string' },
        status: { type: 'string', enum: ['confirmed', 'pending'] },
      },
      required: ['customer_name', 'booking_date', 'booking_time'],
    },
  },
  {
    name: 'cancel_booking',
    description: 'Cancel an existing booking by id. Returns success or an error.',
    input_schema: {
      type: 'object' as const,
      properties: {
        booking_id: { type: 'string', description: 'UUID of the booking to cancel.' },
      },
      required: ['booking_id'],
    },
  },
  {
    name: 'send_reply',
    description: 'Reply to the owner. Always end your turn with this.',
    input_schema: {
      type: 'object' as const,
      properties: { content: { type: 'string' } },
      required: ['content'],
    },
  },
]

function formatServices(services: ServiceRow[]): string {
  if (!services.length) return '(No services configured.)'
  return services
    .map(s => `- ${s.name} (${s.duration_minutes} min) [id: ${s.id}]`)
    .join('\n')
}

function buildSystem(services: ServiceRow[], todayISO: string): string {
  return (
    'You are Caye, the AI assistant inside this business owner\'s calendar. ' +
    'The owner is talking to you directly (not a customer), so be concise, ' +
    'action-oriented, and skip pleasantries.\n\n' +
    `TODAY: ${todayISO}. Resolve "tomorrow"/"Friday"/etc. relative to this.\n\n` +
    `SERVICES:\n${formatServices(services)}\n\n` +
    'CAPABILITIES:\n' +
    '- list_bookings to look up the schedule\n' +
    '- create_booking to add a booking (the owner is the source of truth — trust their input)\n' +
    '- cancel_booking to cancel an existing booking by id\n' +
    '- send_reply to respond to the owner\n\n' +
    'Always end your turn with send_reply. Keep replies under ~2 short sentences ' +
    'unless the owner asks for detail. When listing bookings, use a compact format.'
  )
}

async function listBookings(workspaceId: string, startDate: string, endDate?: string) {
  const supabase = createServiceClient()
  const end = endDate ?? startDate
  const { data, error } = await supabase
    .from('bookings')
    .select(
      'id, customer_name, booking_date, booking_time, number_of_people, status, service:booking_services(name)'
    )
    .eq('user_id', workspaceId)
    .gte('booking_date', startDate)
    .lte('booking_date', end)
    .neq('status', 'cancelled')
    .order('booking_date')
    .order('booking_time')

  if (error) return { bookings: [], error: error.message }
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

interface CreateBookingInput {
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

async function createBooking(workspaceId: string, input: CreateBookingInput) {
  const supabase = createServiceClient()
  const time = input.booking_time.length === 5 ? `${input.booking_time}:00` : input.booking_time
  const payload = {
    user_id: workspaceId,
    service_id: input.service_id || null,
    customer_name: input.customer_name.trim(),
    customer_phone: input.customer_phone?.trim() || null,
    customer_email: input.customer_email?.trim() || null,
    booking_date: input.booking_date,
    booking_time: time,
    number_of_people: input.number_of_people && input.number_of_people > 0 ? input.number_of_people : 1,
    status: input.status ?? 'confirmed',
    notes: input.notes?.trim() || null,
  }
  const { data, error } = await supabase.from('bookings').insert(payload).select('id').single()
  if (error || !data) return { success: false, error: error?.message ?? 'Insert failed' }
  return { success: true, booking_id: data.id }
}

async function cancelBooking(workspaceId: string, bookingId: string) {
  const supabase = createServiceClient()
  const { data: bk } = await supabase
    .from('bookings')
    .select('id, user_id')
    .eq('id', bookingId)
    .maybeSingle()
  if (!bk || bk.user_id !== workspaceId) return { success: false, error: 'Booking not found' }
  const { error } = await supabase
    .from('bookings')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', bookingId)
  if (error) return { success: false, error: error.message }
  return { success: true, booking_id: bookingId }
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return NextResponse.json({ error: 'Missing auth token' }, { status: 401 })

  const supabase = createServiceClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { messages?: Array<{ role: 'user' | 'assistant'; content: string }> }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const history = body.messages ?? []
  if (history.length === 0) {
    return NextResponse.json({ error: 'messages required' }, { status: 400 })
  }

  const workspaceId = user.id
  const todayISO = new Date().toISOString().slice(0, 10)

  const { data: services } = await supabase
    .from('booking_services')
    .select('id, name, duration_minutes, description')
    .eq('user_id', workspaceId)
    .eq('active', true)
    .order('name')

  const system = buildSystem((services ?? []) as ServiceRow[], todayISO)

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const messages: Anthropic.MessageParam[] = history.map(m => ({
    role: m.role,
    content: m.content,
  }))

  let createdBookingId: string | undefined
  let cancelledBookingId: string | undefined

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      tool_choice: { type: 'any' },
      messages,
    })

    messages.push({ role: 'assistant', content: response.content })

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    )

    if (toolUses.length === 0) {
      const textBlock = response.content.find(b => b.type === 'text')
      const text = textBlock && textBlock.type === 'text' ? textBlock.text : ''
      return NextResponse.json({ reply: text, booking_id: createdBookingId })
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    let replyContent: string | null = null

    for (const tool of toolUses) {
      if (tool.name === 'send_reply') {
        replyContent = (tool.input as { content: string }).content
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: 'ok' })
      } else if (tool.name === 'list_bookings') {
        const input = tool.input as { start_date: string; end_date?: string }
        const result = await listBookings(workspaceId, input.start_date, input.end_date)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
        })
      } else if (tool.name === 'create_booking') {
        const result = await createBooking(workspaceId, tool.input as CreateBookingInput)
        if (result.success && result.booking_id) createdBookingId = result.booking_id
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
          is_error: !result.success,
        })
      } else if (tool.name === 'cancel_booking') {
        const input = tool.input as { booking_id: string }
        const result = await cancelBooking(workspaceId, input.booking_id)
        if (result.success) cancelledBookingId = input.booking_id
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
          is_error: !result.success,
        })
      }
    }

    if (replyContent !== null) {
      if (createdBookingId) {
        syncBookingToCalendar(workspaceId, createdBookingId, 'upsert').catch(err =>
          console.error('[ask-caye] Calendar sync (upsert) failed:', err)
        )
      }
      if (cancelledBookingId) {
        syncBookingToCalendar(workspaceId, cancelledBookingId, 'delete').catch(err =>
          console.error('[ask-caye] Calendar sync (delete) failed:', err)
        )
      }
      return NextResponse.json({
        reply: replyContent,
        booking_id: createdBookingId,
        cancelled_booking_id: cancelledBookingId,
      })
    }

    messages.push({ role: 'user', content: toolResults })
  }

  return NextResponse.json({ reply: 'Sorry — that took too many steps. Try a simpler ask.' })
}
