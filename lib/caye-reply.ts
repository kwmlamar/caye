import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import type { VoiceProfile } from '@/lib/voice-profile'
import type { ContactStyleProfile } from '@/types/database'
import { createServiceClient } from './supabase-server'
import { detectIdentityLeak } from './caye-identity-guard'
import { formatHistoryBlock } from './conversation-history'

export type CayeAutoReply =
  | { action: 'reply'; content: string; bookingId?: string }
  | { action: 'hold'; reason: string; note: string }

interface ServiceRow {
  id: string
  name: string
  duration_minutes: number
  description?: string | null
  is_shared: boolean
  max_capacity: number
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
        duration_minutes: {
          type: 'number',
          description:
            'How long the booking lasts, in minutes. Omit when the customer didn\'t say — ' +
            'the service\'s default duration (or 120 min) will be used.',
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
      const capacity = s.is_shared
        ? `, SHARED group tour, capacity ${s.max_capacity} guests/slot`
        : ', exclusive (one party per slot)'
      return `- ${s.name} (${s.duration_minutes} min${capacity}) [id: ${s.id}]${desc}`
    })
    .join('\n')
}

interface BusinessLinks {
  booking_url: string | null
  website_url: string | null
}

function buildSystem(
  systemPrompt: string,
  voiceProfile: VoiceProfile | undefined,
  contactProfile: ContactStyleProfile | undefined,
  businessLinks: BusinessLinks | undefined,
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

  if (contactProfile) {
    s +=
      '\n\nCUSTOMER STYLE — adapt your reply to match this person\'s communication style:\n' +
      `- Formality: ${contactProfile.formality}\n` +
      `- Style: ${contactProfile.message_style}\n` +
      `- Language notes: ${contactProfile.language_notes}\n` +
      'Match their energy — if they\'re brief, be brief. If they\'re formal, stay professional. ' +
      'If they use emoji, one or two is fine. Mirror their vibe without abandoning the VOICE PROFILE ' +
      'above (their style controls tone; your owner\'s voice profile controls word choice and identity).'
  }

  // Inject business links only when at least one is set — empty block adds
  // noise to the prompt and could confuse the model into mentioning links
  // that don't exist.
  if (businessLinks && (businessLinks.booking_url || businessLinks.website_url)) {
    const lines: string[] = []
    if (businessLinks.booking_url) lines.push(`- Booking page: ${businessLinks.booking_url}`)
    if (businessLinks.website_url) lines.push(`- Website: ${businessLinks.website_url}`)
    s +=
      '\n\nBUSINESS LINKS — share when relevant, do not force:\n' +
      lines.join('\n') +
      '\n' +
      'Use these naturally when a customer asks "can I book online?", "where can I see your tours?", ' +
      'or as a self-service option when you hold_for_human ("I\'ll have someone confirm — ' +
      'meanwhile you can browse at <link>"). Never paste them as a robotic footer on every reply ' +
      'and never invent URLs that aren\'t listed here.'
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
    'the conversation. Don\'t demand it all in one message.\n' +
    '- SHARED services: multiple parties can book the same slot up to the service capacity. ' +
    'check_availability returns total_guests + capacity_remaining per slot. If there\'s room, ' +
    'create_booking with the same date/time as the existing slot — the new party joins the group. ' +
    'If the slot is full, suggest the next time. Mention to the customer they\'ll be joining others.\n' +
    '- EXCLUSIVE services: only one party per slot. If the slot has any booking, suggest another time.'

  s += isEmail
    ? '\n\nWrite only the reply body — no headers, no markdown, no subject line. Plain prose.' +
      '\n\nSIGN-OFF: Use the exact sign-off block specified earlier in this system prompt — verbatim, ' +
      'including name, business, phone, and email if given. Do NOT invent your own signature. ' +
      'Do NOT sign as "Caye" or any variant. Do NOT mention that you are an AI, assistant, ' +
      'receptionist, or automated system anywhere in the body or the sign-off. From the recipient\'s ' +
      'point of view, the email is from the business owner — write as them, not on their behalf.'
    : isFirstMessage
    ? `\n\nWrite only the reply body. Plain conversational prose — no markdown. Keep it brief — this is ${channel}, not email. Open with a warm, natural greeting. Never mention that you are an AI, assistant, or automated.`
    : `\n\nWrite only the reply body. Plain conversational prose — no markdown. Keep it brief — this is ${channel}, not email. Do NOT open with a greeting or the customer's name — jump straight to the answer. Never mention that you are an AI, assistant, or automated.`

  s += '\n\nSCOPE: Only engage with messages that are actually for the business — booking inquiries, ' +
    'customer questions, payment/logistics follow-ups. If the message is a newsletter, marketing blast, ' +
    'industry/coaching content, cold sales outreach, partnership pitch, vendor notification, or any other ' +
    'non-customer message, call hold_for_human with reason "not a customer message" and let the owner ' +
    'decide. Never make commitments on the owner\'s behalf about signing up for things, attending events, ' +
    'trying products, or replying to industry peers.'

  s += '\n\nYou MUST end every turn by calling either send_reply or hold_for_human.'

  return s
}

interface AvailabilityRow {
  service_id: string | null
  booking_time: string
  number_of_people: number
  status: string
  service: { name: string; duration_minutes: number; is_shared: boolean; max_capacity: number }[] | null
}

interface AvailabilitySlot {
  time: string
  service: string | null
  service_id: string | null
  duration_minutes: number
  is_shared: boolean
  max_capacity: number | null
  total_guests: number
  capacity_remaining: number | null
  parties: Array<{ name?: string; guests: number }>
}

async function checkAvailability(
  workspaceId: string,
  date: string
): Promise<{ date: string; slots: AvailabilitySlot[] }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('bookings')
    .select('service_id, customer_name, booking_time, number_of_people, status, service:booking_services(name, duration_minutes, is_shared, max_capacity)')
    .eq('user_id', workspaceId)
    .eq('booking_date', date)
    .neq('status', 'cancelled')
    .order('booking_time')

  if (error) {
    return { date, slots: [] }
  }

  // Group rows by (service_id, time) so shared slots aggregate
  type Key = string
  const groups = new Map<Key, { rows: (AvailabilityRow & { customer_name?: string })[]; svc?: AvailabilityRow['service'] }>()
  const rows = (data ?? []) as unknown as (AvailabilityRow & { customer_name?: string })[]
  for (const r of rows) {
    const k = `${r.service_id ?? 'none'}|${r.booking_time}`
    if (!groups.has(k)) groups.set(k, { rows: [], svc: r.service })
    groups.get(k)!.rows.push(r)
  }

  const slots: AvailabilitySlot[] = []
  for (const { rows, svc } of groups.values()) {
    const total = rows.reduce((a, b) => a + b.number_of_people, 0)
    const s = svc?.[0]
    const isShared = s?.is_shared ?? false
    const capacity = isShared ? s?.max_capacity ?? null : 1 // exclusive = 1 "slot"
    slots.push({
      time: rows[0].booking_time.slice(0, 5),
      service: s?.name ?? null,
      service_id: rows[0].service_id,
      duration_minutes: s?.duration_minutes ?? 120,
      is_shared: isShared,
      max_capacity: capacity,
      total_guests: total,
      capacity_remaining: capacity != null ? Math.max(0, capacity - total) : null,
      parties: rows.map(r => ({ name: r.customer_name, guests: r.number_of_people })),
    })
  }
  return { date, slots }
}

interface CreateBookingInput {
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
    duration_minutes:
      input.duration_minutes && input.duration_minutes > 0 ? input.duration_minutes : null,
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
  /**
   * channel_message_id of the inbound message we're replying to.
   * Used to exclude the current message from the fetched history so we
   * don't echo it back as prior context.
   */
  currentChannelMessageId?: string | null
}

const HISTORY_LIMIT = 10

interface HistoryRow {
  sender_type: 'customer' | 'business'
  content: string | null
  sent_at: string
  channel_message_id: string | null
  metadata: Record<string, unknown> | null
}

/**
 * Pull the last N messages from this conversation so Caye sees what was
 * already said. Excludes the current inbound (by channel_message_id) so
 * it isn't echoed back as prior context.
 */
async function fetchConversationHistory(
  conversationId: string,
  excludeChannelMessageId: string | null
): Promise<HistoryRow[]> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('unified_messages')
    .select('sender_type, content, sent_at, channel_message_id, metadata')
    .eq('conversation_id', conversationId)
    .eq('is_internal', false)
    .order('sent_at', { ascending: false })
    .limit(HISTORY_LIMIT + 1)

  if (error || !data) return []

  const rows = data as HistoryRow[]
  const filtered = excludeChannelMessageId
    ? rows.filter(r => r.channel_message_id !== excludeChannelMessageId)
    : rows

  // Reverse to chronological order (oldest first) and cap at limit
  return filtered.slice(0, HISTORY_LIMIT).reverse()
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
    .select('id, name, duration_minutes, description, is_shared, max_capacity')
    .eq('user_id', inbound.workspaceId)
    .eq('active', true)
    .order('name')

  const services = (serviceRows ?? []) as ServiceRow[]
  const todayISO = new Date().toISOString().slice(0, 10)

  // Fetch the workspace's business links so Caye can reference them when
  // contextually appropriate. Non-fatal — no links just means Caye replies
  // without mentioning any external URLs (the existing behaviour).
  let businessLinks: BusinessLinks | undefined
  const { data: workspaceRow } = await supabase
    .from('customers')
    .select('booking_url, website_url')
    .eq('id', inbound.workspaceId)
    .maybeSingle()
  if (workspaceRow && (workspaceRow.booking_url || workspaceRow.website_url)) {
    businessLinks = {
      booking_url: workspaceRow.booking_url,
      website_url: workspaceRow.website_url,
    }
  }

  // If this conversation is linked to a contact, look up their style profile
  // so Caye can mirror their energy. Fetch is non-fatal — no profile yet just
  // means we fall back to the owner's default tone.
  let contactProfile: ContactStyleProfile | undefined
  if (inbound.conversationId) {
    const { data: convRow } = await supabase
      .from('unified_conversations')
      .select('contact_id')
      .eq('id', inbound.conversationId)
      .maybeSingle()
    if (convRow?.contact_id) {
      const { data: contactRow } = await supabase
        .from('contacts')
        .select('ai_contact_profile')
        .eq('id', convRow.contact_id)
        .maybeSingle()
      contactProfile =
        (contactRow?.ai_contact_profile as ContactStyleProfile | null) ?? undefined
    }
  }

  const system = buildSystem(
    systemPrompt,
    voiceProfile,
    contactProfile,
    businessLinks,
    inbound.channel,
    isEmail,
    inbound.isFirstMessage ?? false,
    services,
    todayISO
  )

  // Pull prior conversation history (if we have a conversation to query) so
  // Caye sees what was already said. Non-fatal — empty history just means
  // first message or a fetch failure.
  const history = inbound.conversationId
    ? await fetchConversationHistory(
        inbound.conversationId,
        inbound.currentChannelMessageId ?? null
      )
    : []
  const historyBlock = formatHistoryBlock(history)

  const newMessageBlock = isEmail
    ? `Reply to this email:\n\nFrom: ${inbound.senderName}\nSubject: ${inbound.subject || '(no subject)'}\n\n${inbound.body}`
    : `Reply to this ${inbound.channel} message:\n\nFrom: ${inbound.senderName}\n\n${inbound.body}`

  const userContent = `${historyBlock}${newMessageBlock}`

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
        const leak = detectIdentityLeak(textBlock.text)
        if (leak) {
          console.warn(`[caye-reply] Identity guard blocked freeform reply: ${leak}`)
          return {
            action: 'hold',
            reason: `Identity guard: ${leak}`,
            note:
              `Caye drafted a reply (no tool call) but the identity guard blocked it (${leak}). ` +
              `Review the draft below and send manually if appropriate.\n\n---\n\n${textBlock.text}`,
          }
        }
        return { action: 'reply', content: textBlock.text, bookingId: createdBookingId }
      }
      throw new Error('[caye-reply] No tool call or text in Claude response')
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    let terminal: CayeAutoReply | null = null

    for (const tool of toolUses) {
      if (tool.name === 'send_reply') {
        const input = tool.input as { content: string }
        const leak = detectIdentityLeak(input.content)
        if (leak) {
          // Identity guard tripped — don't ship the reply. Hand to the owner
          // with the draft attached so they can decide.
          console.warn(`[caye-reply] Identity guard blocked reply: ${leak}`)
          terminal = {
            action: 'hold',
            reason: `Identity guard: ${leak}`,
            note:
              `Caye drafted a reply but the identity guard blocked it (${leak}). ` +
              `Review the draft below and send manually if appropriate.\n\n---\n\n${input.content}`,
          }
        } else {
          terminal = { action: 'reply', content: input.content, bookingId: createdBookingId }
        }
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
