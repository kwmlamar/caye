import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import type { VoiceProfile } from '@/lib/voice-profile'
import { createServiceClient } from './supabase-server'

export type CayeAutoReply =
  | { action: 'reply'; content: string; bookingId?: string }
  | { action: 'hold'; reason: string; note: string }

interface ServiceRow {
  id: string
  name: string
  duration_minutes: number
  description?: string | null
}

const MAX_TOOL_ROUNDS = 6

// Tools are declared once at module scope so prompt caching can pin them.
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'check_availability',
    description:
      'Look up what bookings already exist on a given date for this business. ' +
      'ALWAYS call this before create_booking so you can recommend an open slot ' +
      'and avoid double-booking. Returns a list of existing bookings with their ' +
      'start time, duration, and party size.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: {
          type: 'string',
          description: 'The date to check, in YYYY-MM-DD format.',
        },
      },
      required: ['date'],
    },
  },
  {
    name: 'create_booking',
    description:
      'Create a confirmed or pending booking for this customer. Only call this ' +
      'after the customer has clearly agreed to a specific date and time AND you ' +
      'have called check_availability for that date. Use the customer\'s name from ' +
      'the conversation. If you don\'t know their phone or email, omit those fields ' +
      '— don\'t make them up. After this tool succeeds, you MUST then call ' +
      'send_reply with a warm confirmation message that restates the booking details.',
    input_schema: {
      type: 'object' as const,
      properties: {
        customer_name: { type: 'string', description: 'Customer full name.' },
        customer_phone: { type: 'string', description: 'Phone number if known.' },
        customer_email: { type: 'string', description: 'Email if known.' },
        booking_date: { type: 'string', description: 'YYYY-MM-DD.' },
        booking_time: { type: 'string', description: '24-hour HH:MM start time.' },
        number_of_people: {
          type: 'number',
          description: 'Number of guests. Default to 1 if not mentioned.',
        },
        service_id: {
          type: 'string',
          description: 'Service id from the AVAILABLE SERVICES list. Omit if none fits.',
        },
        notes: { type: 'string', description: 'Any special requests or context.' },
        status: {
          type: 'string',
          enum: ['confirmed', 'pending'],
          description:
            'Use "confirmed" when the customer has clearly agreed. Use "pending" ' +
            'when they\'ve asked to hold a slot but still need to confirm something.',
        },
      },
      required: ['customer_name', 'booking_date', 'booking_time'],
    },
  },
  {
    name: 'send_reply',
    description:
      'Send a reply to the customer. Use this when you can confidently handle the message.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The reply to send to the customer.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'hold_for_human',
    description:
      'Hold this conversation for the business owner to handle personally. Use this when: ' +
      'the customer has a complaint or is upset; the request needs specific info you don\'t have ' +
      '(exact pricing beyond what services list, custom quotes, special arrangements); the ' +
      'customer wants to reschedule or cancel an existing booking (you can\'t do that yet); ' +
      'the message is ambiguous and risky to answer wrong; or anything that feels like it ' +
      'needs a human touch. Do NOT hold just because they want to book — use create_booking.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'One short sentence — why you are stepping back. Shown in the inbox as a label.',
        },
        note: {
          type: 'string',
          description:
            'A brief internal note for the business owner. Write it like a handoff: what the ' +
            'customer needs, any relevant context, what you\'d suggest doing. 2-4 sentences max.',
        },
      },
      required: ['reason', 'note'],
    },
    cache_control: { type: 'ephemeral' },
  },
]

function formatServicesList(services: ServiceRow[]): string {
  if (!services.length) {
    return '(No services configured. Don\'t invent any — if a service is required, hold_for_human.)'
  }
  return services
    .map(s => {
      const desc = s.description ? ` — ${s.description}` : ''
      return `- ${s.name} (${s.duration_minutes} min) [id: ${s.id}]${desc}`
    })
    .join('\n')
}

function buildSystem(
  systemPrompt: string,
  voiceProfile: VoiceProfile | undefined,
  channel: string,
  isEmail: boolean,
  isFirstMessage: boolean,
  services: ServiceRow[],
  todayISO: string
): string {
  let s = systemPrompt

  if (voiceProfile) {
    s +=
      '\n\nVOICE PROFILE — write in this person\'s actual style:\n' +
      `- Formality: ${voiceProfile.formality_level}\n` +
      `- Style: ${voiceProfile.writing_style}\n` +
      `- Common phrases to use naturally: ${(voiceProfile.common_phrases ?? []).join(', ')}\n` +
      `- Typical greeting: ${voiceProfile.greeting_style}\n` +
      `- Typical sign-off: ${voiceProfile.signoff_style}\n` +
      `- Tone notes: ${voiceProfile.tone_notes}`
  }

  s +=
    `\n\nTODAY'S DATE: ${todayISO}. ` +
    'When the customer says "tomorrow" / "this Saturday" / etc., resolve it against today.'

  s += `\n\nAVAILABLE SERVICES:\n${formatServicesList(services)}`

  s +=
    '\n\nBOOKING POLICY:\n' +
    '- You can create bookings directly using check_availability + create_booking.\n' +
    '- Always check availability for a date before creating a booking on it.\n' +
    '- Only create a booking when the customer has clearly agreed to a specific date and time.\n' +
    '- If they\'re vague ("sometime next week"), reply asking for a specific day and time first.\n' +
    '- If they want to RESCHEDULE or CANCEL an existing booking, hold_for_human — you can\'t edit yet.\n' +
    '- For new bookings: ask for what you need (name, party size, date, time) over the course of ' +
    'the conversation. Don\'t demand it all in one message.'

  s += isEmail
    ? '\n\nWrite only the reply body — no headers, no markdown. Plain prose, sign off naturally.'
    : isFirstMessage
    ? `\n\nWrite only the reply body. Plain conversational prose — no markdown. Keep it brief — this is ${channel}, not email. Open with a warm, natural greeting.`
    : `\n\nWrite only the reply body. Plain conversational prose — no markdown. Keep it brief — this is ${channel}, not email. Do NOT open with a greeting or the customer's name — jump straight to the answer.`

  s += '\n\nYou MUST end every turn by calling either send_reply or hold_for_human.'

  return s
}

interface AvailabilityRow {
  booking_time: string
  number_of_people: number
  status: string
  service: { name: string; duration_minutes: number }[] | null
}

async function checkAvailability(
  workspaceId: string,
  date: string
): Promise<{ date: string; bookings: Array<{ time: string; duration_minutes: number; party_size: number; service: string | null; status: string }> }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('bookings')
    .select('booking_time, number_of_people, status, service:booking_services(name, duration_minutes)')
    .eq('user_id', workspaceId)
    .eq('booking_date', date)
    .neq('status', 'cancelled')
    .order('booking_time')

  if (error) {
    return { date, bookings: [] }
  }

  const rows = (data ?? []) as unknown as AvailabilityRow[]
  return {
    date,
    bookings: rows.map(r => ({
      time: r.booking_time.slice(0, 5),
      duration_minutes: r.service?.[0]?.duration_minutes ?? 120,
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

async function createBookingFromCaye(
  workspaceId: string,
  conversationId: string | null,
  input: CreateBookingInput,
  fallbackEmail: string | null
): Promise<{ success: boolean; booking_id?: string; error?: string }> {
  const supabase = createServiceClient()

  const timeWithSeconds = input.booking_time.length === 5 ? `${input.booking_time}:00` : input.booking_time

  const payload = {
    user_id: workspaceId,
    conversation_id: conversationId,
    service_id: input.service_id || null,
    customer_name: input.customer_name.trim(),
    customer_phone: input.customer_phone?.trim() || null,
    customer_email: input.customer_email?.trim() || fallbackEmail || null,
    booking_date: input.booking_date,
    booking_time: timeWithSeconds,
    number_of_people: input.number_of_people && input.number_of_people > 0 ? input.number_of_people : 1,
    status: input.status ?? 'confirmed',
    notes: input.notes?.trim() || null,
  }

  const { data, error } = await supabase.from('bookings').insert(payload).select('id').single()
  if (error || !data) {
    return { success: false, error: error?.message ?? 'Insert failed' }
  }
  return { success: true, booking_id: data.id }
}

export interface CayeAutoReplyInput {
  senderName: string
  body: string
  channel: 'whatsapp' | 'instagram' | 'messenger' | 'email'
  subject?: string
  isFirstMessage?: boolean
  workspaceId: string
  conversationId?: string | null
  senderEmail?: string | null
}

/**
 * Core Caye auto-reply engine used by all channel webhooks.
 * Runs a tool-use loop so Caye can check availability and create bookings
 * before terminating with send_reply or hold_for_human.
 */
export async function generateCayeAutoReply(
  systemPrompt: string,
  inbound: CayeAutoReplyInput,
  voiceProfile?: VoiceProfile
): Promise<CayeAutoReply> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const isEmail = inbound.channel === 'email'

  // Pull services up front so Caye can reference them in the same turn.
  const supabase = createServiceClient()
  const { data: serviceRows } = await supabase
    .from('booking_services')
    .select('id, name, duration_minutes, description')
    .eq('user_id', inbound.workspaceId)
    .eq('active', true)
    .order('name')

  const services = (serviceRows ?? []) as ServiceRow[]
  const todayISO = new Date().toISOString().slice(0, 10)

  const system = buildSystem(
    systemPrompt,
    voiceProfile,
    inbound.channel,
    isEmail,
    inbound.isFirstMessage ?? false,
    services,
    todayISO
  )

  const userContent = isEmail
    ? `Reply to this email:\n\nFrom: ${inbound.senderName}\nSubject: ${inbound.subject || '(no subject)'}\n\n${inbound.body}`
    : `Reply to this ${inbound.channel} message:\n\nFrom: ${inbound.senderName}\n\n${inbound.body}`

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }]

  let createdBookingId: string | undefined

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
      if (textBlock && textBlock.type === 'text' && textBlock.text.trim()) {
        return { action: 'reply', content: textBlock.text, bookingId: createdBookingId }
      }
      throw new Error('[caye-reply] No tool call or text in Claude response')
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    let terminal: CayeAutoReply | null = null

    for (const tool of toolUses) {
      if (tool.name === 'send_reply') {
        const input = tool.input as { content: string }
        terminal = { action: 'reply', content: input.content, bookingId: createdBookingId }
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: 'ok' })
      } else if (tool.name === 'hold_for_human') {
        const input = tool.input as { reason: string; note: string }
        terminal = { action: 'hold', reason: input.reason, note: input.note }
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: 'ok' })
      } else if (tool.name === 'check_availability') {
        const input = tool.input as { date: string }
        const result = await checkAvailability(inbound.workspaceId, input.date)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
        })
      } else if (tool.name === 'create_booking') {
        const input = tool.input as CreateBookingInput
        const result = await createBookingFromCaye(
          inbound.workspaceId,
          inbound.conversationId ?? null,
          input,
          inbound.senderEmail ?? null
        )
        if (result.success && result.booking_id) createdBookingId = result.booking_id
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
          is_error: !result.success,
        })
      } else {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: `Unknown tool: ${tool.name}`,
          is_error: true,
        })
      }
    }

    if (terminal) return terminal

    messages.push({ role: 'user', content: toolResults })
  }

  throw new Error('[caye-reply] Max tool rounds exceeded without send_reply or hold_for_human')
}
