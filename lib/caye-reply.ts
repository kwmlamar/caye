import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import type { VoiceProfile } from '@/lib/voice-profile'
import type { ContactStyleProfile } from '@/types/database'
import { createServiceClient } from './supabase-server'
import { detectIdentityLeak } from './caye-identity-guard'
import { formatHistoryBlock } from './conversation-history'
import { checkBookingAutonomy, AUTONOMY_WINDOW_HOURS } from './booking-policy'
import { syncBookingToCalendar } from './calendar-sync'
import {
  summarizeBookingHistory,
  formatCustomerHistoryBlock,
  type CustomerHistorySummary,
  type BookingHistoryRow,
} from './customer-history'
import { classifyInbound, toneHintFor, type InboundCategory } from './inbound-classifier'
import { formatCustomerFactsBlock, type CustomerFacts } from './customer-facts'

export type CayeAutoReply =
  | { action: 'reply'; content: string; bookingId?: string }
  | { action: 'hold'; reason: string; note: string; proposedReply?: string }

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
    name: 'find_bookings',
    description:
      'Look up existing bookings for a customer. ALWAYS call this BEFORE cancel_booking ' +
      'when a customer asks to cancel — you need the booking_id to act. Match by ' +
      'customer_email first; fall back to customer_name only when email lookup returns ' +
      'nothing. Returns active (confirmed/pending) bookings dated today or later. If the ' +
      'result has 0 rows, hold_for_human (customer claims a booking we have no record of). ' +
      'If it has 2+ rows, reply asking which one (date + service) — DO NOT guess.',
    input_schema: {
      type: 'object' as const,
      properties: {
        customer_email: {
          type: 'string',
          description: 'The sender\'s email address — primary match key.',
        },
        customer_name: {
          type: 'string',
          description:
            'Customer name — fallback when email lookup returns nothing (some older ' +
            'bookings were created without an email captured). Use exact spelling from ' +
            'the conversation.',
        },
      },
      required: [],
    },
  },
  {
    name: 'cancel_booking',
    description:
      'Cancel an existing booking. Only call after find_bookings has returned exactly ' +
      'the booking the customer means. Returns { ok: false, reason: "within_policy_window" } ' +
      'when the booking is within 48 hours of starting — in that case, hold_for_human ' +
      '(last-minute changes are the owner\'s call, not yours). Returns ' +
      '{ ok: false, reason: "booking_in_past" } if the booking has already started — ' +
      'also hold_for_human. On success, you MUST then call send_reply with a brief ' +
      'confirmation. Reply rules: confirm the cancellation, mention they\'re eligible for ' +
      'a full refund per the 48h policy, say the owner will follow up to process the ' +
      'refund. Do NOT promise refund timelines or dollar amounts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        booking_id: {
          type: 'string',
          description: 'The booking id (uuid) from find_bookings.',
        },
        reason: {
          type: 'string',
          description:
            'Why the customer is cancelling — for the internal record. One short sentence.',
        },
      },
      required: ['booking_id'],
    },
  },
  {
    name: 'reschedule_booking',
    description:
      'Move an existing booking to a new date/time of the SAME service. Only call after ' +
      'find_bookings has returned exactly the booking the customer means. The service stays ' +
      'the same — if the customer wants a different service (e.g. switching from Full Bimini ' +
      'Experience to Eat Like a Local), hold_for_human (different price, different operation). ' +
      'Returns { ok: false, reason: "within_policy_window" } when the CURRENT booking is ' +
      'within 48 hours — last-minute changes are the owner\'s call. Returns ' +
      '{ ok: false, reason: "slot_unavailable" } when the new slot is exclusively booked ' +
      'or has no remaining shared capacity — in that case, run check_availability for the ' +
      'new date and suggest an alternative time. If new_time is omitted, the booking\'s ' +
      'existing time is preserved on the new date — tell the customer what you did. After ' +
      'success, you MUST call send_reply with a warm confirmation that restates the new ' +
      'date and time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        booking_id: {
          type: 'string',
          description: 'The booking id (uuid) from find_bookings.',
        },
        new_date: {
          type: 'string',
          description: 'New date in YYYY-MM-DD.',
        },
        new_time: {
          type: 'string',
          description:
            'New start time in 24-hour HH:MM. Omit to preserve the booking\'s existing ' +
            'time on the new date — natural default when the customer says "move to Sunday" ' +
            'without specifying a time.',
        },
        duration_minutes: {
          type: 'number',
          description:
            'Override duration. Omit to keep the existing duration — usually correct.',
        },
      },
      required: ['booking_id', 'new_date'],
    },
  },
  {
    name: 'hold_for_human',
    description:
      'Hold this conversation for the business owner to handle personally. Use this when: ' +
      'the customer has a complaint or is upset; the request needs specific info you don\'t have ' +
      '(exact pricing beyond what services list, custom quotes, special arrangements); the ' +
      'customer wants to change to a different SERVICE (pricing implication — your reschedule ' +
      'tool only moves date/time of the same service); cancel_booking or reschedule_booking ' +
      'returned within_policy_window or booking_in_past; the message is ambiguous and risky ' +
      'to answer wrong; or anything that feels like it needs a human touch. Do NOT hold just ' +
      'because they want to book / cancel / reschedule — use the dedicated tools when the ' +
      'booking is >48h out. ' +
      'IMPORTANT: when you hold, ALSO populate proposed_reply with the reply you WOULD have sent ' +
      'if you were confident. This becomes the operator\'s starting draft — they will review it, ' +
      'edit it, and send it themselves. Voice rules apply to proposed_reply exactly as they apply ' +
      'to send_reply content: no emoji, no tropical / island metaphors, match the operator voice ' +
      'profile. Skip proposed_reply only if you genuinely can\'t draft anything useful (e.g. ' +
      'angry complaint with zero context).',
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
        proposed_reply: {
          type: 'string',
          description:
            'The reply you would have sent if you were confident — used as the operator\'s ' +
            'starting draft. Same voice rules as send_reply content. Optional: omit only if ' +
            'you genuinely can\'t draft anything useful.',
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
  contactFacts: CustomerFacts | undefined,
  businessLinks: BusinessLinks | undefined,
  customerHistory: CustomerHistorySummary | undefined,
  inboundCategory: InboundCategory | null,
  channel: string,
  isEmail: boolean,
  isFirstMessage: boolean,
  services: ServiceRow[],
  todayISO: string
): string {
  let s = systemPrompt

  s +=
    '\n\nBUSINESS IDENTITY RULES:\n' +
    '- The operator\'s business is defined by the workspace context above. ' +
    'Never invent a name for the business, never refer to it by anything ' +
    'other than the name in the workspace context. If the workspace context ' +
    'does not name the business, say "your business" or "we" — never make up ' +
    'a name like "Sunset Cruise" or "Island Tours".\n' +
    '- If an inbound email or message looks like it\'s directed at a different ' +
    'business than this workspace serves, explain that explicitly without ' +
    'inventing a name for either side. Use phrases like "this doesn\'t match ' +
    'our services" or "this seems intended for a different company" — never ' +
    'hallucinated business names.'

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

  // Customer history (returning customer signal). The block renders empty
  // for first-timers so this is safe to call unconditionally.
  if (customerHistory) {
    const historyBlock = formatCustomerHistoryBlock(customerHistory)
    if (historyBlock) s += '\n\n' + historyBlock
  }

  // Customer facts (operational truths they told us — allergies, mobility,
  // group, etc.). The block renders empty when no facts are populated.
  if (contactFacts) {
    const factsBlock = formatCustomerFactsBlock(contactFacts)
    if (factsBlock) s += '\n\n' + factsBlock
  }

  // Inbound-context tone modifier. Pure classifier picks a category from
  // the inbound body (or returns null when uncertain); toneHintFor maps
  // the category to a short prompt addendum. When category is null the
  // hint is empty — Caye falls back to her default tone.
  const toneHint = toneHintFor(inboundCategory)
  if (toneHint) s += '\n\n' + toneHint

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
    `- If they want to CANCEL: call find_bookings → cancel_booking. The tool enforces a ${AUTONOMY_WINDOW_HOURS}h policy ` +
    'window — bookings inside that window return an error and you must hold_for_human (Karenda\'s decision). ' +
    'After a successful cancel, send_reply with: confirmation of the cancel, mention that they\'re eligible ' +
    `for a full refund per the ${AUTONOMY_WINDOW_HOURS}h policy, and say the owner will follow up to process the refund. ` +
    'Do NOT promise refund timelines or amounts — you can\'t process payments.\n' +
    '- If they want to RESCHEDULE: call find_bookings → reschedule_booking with new_date (and new_time ' +
    'if they specified one — omit to preserve the existing time on the new date). Same 48h policy applies. ' +
    'If reschedule_booking returns slot_unavailable, call check_availability for the new date and reply ' +
    'with alternative times. After success, send_reply with a warm confirmation restating the new date+time.\n' +
    '- If they want to change to a different SERVICE: hold_for_human (different price, different operation).\n' +
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

  // Mark bookings created by Caye in the notes so the observability panel
  // can distinguish them from owner-created bookings. Cancels/reschedules
  // use the same pattern ([Caye cancel], [Caye reschedule]).
  const createNote = '[Caye create]'
  const trimmedInputNote = input.notes?.trim()
  const notesWithMarker = trimmedInputNote
    ? `${trimmedInputNote}\n\n${createNote}`
    : createNote

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
    notes: notesWithMarker,
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

// ── find_bookings + cancel_booking ──────────────────────────────────────────

interface FoundBooking {
  booking_id: string
  customer_name: string
  service_name: string | null
  booking_date: string
  booking_time: string
  number_of_people: number
  status: string
  duration_minutes: number | null
}

interface FindBookingsResult {
  match_count: number
  bookings: FoundBooking[]
  /** Set when we fell back to name-match because email returned zero. Tells
   *  Caye to confirm with the customer before acting on a name-only hit. */
  matched_by: 'email' | 'name' | 'none'
}

/**
 * Look up active (confirmed/pending), future-dated bookings for a customer.
 * Email-first; name fallback only when email returns zero. The fallback
 * marker (`matched_by: 'name'`) tells Caye to verify before acting.
 */
async function findBookings(
  workspaceId: string,
  input: { customer_email?: string; customer_name?: string }
): Promise<FindBookingsResult> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().slice(0, 10)
  const email = input.customer_email?.trim().toLowerCase()
  const name = input.customer_name?.trim()

  const selectCols =
    'id, customer_name, booking_date, booking_time, number_of_people, status, duration_minutes, ' +
    'service:booking_services(name)'

  type Row = {
    id: string
    customer_name: string
    booking_date: string
    booking_time: string
    number_of_people: number
    status: string
    duration_minutes: number | null
    service: { name: string }[] | null
  }

  let rows: Row[] = []
  let matched_by: 'email' | 'name' | 'none' = 'none'

  if (email) {
    const { data } = await supabase
      .from('bookings')
      .select(selectCols)
      .eq('user_id', workspaceId)
      .in('status', ['confirmed', 'pending'])
      .gte('booking_date', today)
      .ilike('customer_email', email)
      .order('booking_date')
      .order('booking_time')
    rows = (data ?? []) as unknown as Row[]
    if (rows.length) matched_by = 'email'
  }

  if (!rows.length && name) {
    const { data } = await supabase
      .from('bookings')
      .select(selectCols)
      .eq('user_id', workspaceId)
      .in('status', ['confirmed', 'pending'])
      .gte('booking_date', today)
      .ilike('customer_name', name)
      .order('booking_date')
      .order('booking_time')
    rows = (data ?? []) as unknown as Row[]
    if (rows.length) matched_by = 'name'
  }

  const bookings: FoundBooking[] = rows.map(r => ({
    booking_id: r.id,
    customer_name: r.customer_name,
    service_name: r.service?.[0]?.name ?? null,
    booking_date: r.booking_date,
    booking_time: r.booking_time.slice(0, 5),
    number_of_people: r.number_of_people,
    status: r.status,
    duration_minutes: r.duration_minutes,
  }))

  return { match_count: bookings.length, bookings, matched_by }
}

type CancelResult =
  | { ok: true; booking_id: string; hours_until_booking: number }
  | { ok: false; reason: 'within_policy_window' | 'booking_in_past' | 'not_found' | 'already_cancelled' | 'db_error'; detail?: string }

/**
 * Cancel an existing booking. Enforces the autonomy policy window
 * (defense in depth — the prompt also instructs Caye, but we don't trust
 * the prompt for irreversible operations). On success, syncs the Zoho
 * Calendar event delete in the background.
 */
async function cancelBookingFromCaye(
  workspaceId: string,
  bookingId: string,
  workspaceTimezone: string,
  reason: string | undefined
): Promise<CancelResult> {
  const supabase = createServiceClient()

  const { data: booking, error: readErr } = await supabase
    .from('bookings')
    .select('id, status, booking_date, booking_time, notes')
    .eq('id', bookingId)
    .eq('user_id', workspaceId)
    .maybeSingle()

  if (readErr || !booking) {
    return { ok: false, reason: 'not_found' }
  }
  if (booking.status === 'cancelled') {
    return { ok: false, reason: 'already_cancelled' }
  }

  const gate = checkBookingAutonomy({
    bookingDate: booking.booking_date,
    bookingTime: booking.booking_time.slice(0, 5),
    timezone: workspaceTimezone,
  })

  if (!gate.ok) {
    return { ok: false, reason: gate.reason, detail: `~${gate.hoursUntilBooking.toFixed(1)}h until booking` }
  }

  const cancellationNote = reason ? `[Caye cancel] ${reason}` : '[Caye cancel]'
  const noteWithReason = booking.notes
    ? `${booking.notes}\n\n${cancellationNote}`
    : cancellationNote

  const { error: updErr } = await supabase
    .from('bookings')
    .update({
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      notes: noteWithReason,
    })
    .eq('id', bookingId)

  if (updErr) {
    return { ok: false, reason: 'db_error', detail: updErr.message }
  }

  // Calendar delete fire-and-forget — booking is already cancelled in DB,
  // calendar sync failure is recoverable manually.
  syncBookingToCalendar(workspaceId, bookingId, 'delete').catch(err =>
    console.error('[caye-reply] cancel calendar sync failed:', err)
  )

  return { ok: true, booking_id: bookingId, hours_until_booking: gate.hoursUntilBooking }
}

// ── end find_bookings + cancel_booking ──────────────────────────────────────

// ── reschedule_booking ──────────────────────────────────────────────────────

type RescheduleResult =
  | {
      ok: true
      booking_id: string
      new_date: string
      new_time: string
      time_was_preserved: boolean
      hours_until_original_booking: number
    }
  | {
      ok: false
      reason:
        | 'within_policy_window'
        | 'booking_in_past'
        | 'not_found'
        | 'already_cancelled'
        | 'slot_unavailable'
        | 'db_error'
      detail?: string
    }

/**
 * Move an existing booking to a new date/time of the SAME service.
 *
 * Policy gate runs against the booking's CURRENT start (you can't sneak in
 * a reschedule on a booking that's 12h out). Availability check runs for
 * the new slot — exclusive-taken or shared-full rejects with
 * 'slot_unavailable' so Caye can suggest alternatives.
 *
 * Time-preservation default: if newTime is omitted, the booking's existing
 * time is used on the new date. The caller (Caye via the tool description)
 * is told to mention this in the reply.
 */
async function rescheduleBookingFromCaye(
  workspaceId: string,
  bookingId: string,
  newDate: string,
  newTime: string | undefined,
  newDurationMinutes: number | undefined,
  workspaceTimezone: string
): Promise<RescheduleResult> {
  const supabase = createServiceClient()

  // Pull the booking + its service config (capacity, sharing).
  type BookingRow = {
    id: string
    status: string
    booking_date: string
    booking_time: string
    number_of_people: number
    service_id: string | null
    duration_minutes: number | null
    notes: string | null
    service: { is_shared: boolean; max_capacity: number }[] | null
  }
  const { data: bookingRaw, error: readErr } = await supabase
    .from('bookings')
    .select(
      'id, status, booking_date, booking_time, number_of_people, service_id, ' +
        'duration_minutes, notes, ' +
        'service:booking_services(is_shared, max_capacity)'
    )
    .eq('id', bookingId)
    .eq('user_id', workspaceId)
    .maybeSingle()

  const booking = bookingRaw as unknown as BookingRow | null
  if (readErr || !booking) return { ok: false, reason: 'not_found' }
  if (booking.status === 'cancelled') return { ok: false, reason: 'already_cancelled' }

  // Policy gate against the CURRENT booking time. Prevents the move-then-cancel
  // loophole on near-term bookings.
  const gate = checkBookingAutonomy({
    bookingDate: booking.booking_date,
    bookingTime: booking.booking_time.slice(0, 5),
    timezone: workspaceTimezone,
  })
  if (!gate.ok) {
    return {
      ok: false,
      reason: gate.reason,
      detail: `~${gate.hoursUntilBooking.toFixed(1)}h until original booking`,
    }
  }

  // Default to existing time when the customer didn't specify a new one.
  const existingTime = booking.booking_time.slice(0, 5)
  const targetTime = (newTime ?? existingTime).slice(0, 5)
  const targetTimeWithSec = `${targetTime}:00`
  const time_was_preserved = !newTime || newTime === existingTime

  // No-op short-circuit: same date and same time = nothing to do.
  if (newDate === booking.booking_date && targetTime === existingTime) {
    return {
      ok: true,
      booking_id: bookingId,
      new_date: newDate,
      new_time: targetTime,
      time_was_preserved,
      hours_until_original_booking: gate.hoursUntilBooking,
    }
  }

  // Availability check at the new slot. Find conflicting bookings at the
  // SAME service + date + time, excluding the booking being rescheduled.
  const svc = booking.service?.[0]
  const isShared = svc?.is_shared ?? false
  const maxCapacity = svc?.max_capacity ?? 1

  if (booking.service_id) {
    const { data: conflicts } = await supabase
      .from('bookings')
      .select('id, number_of_people')
      .eq('user_id', workspaceId)
      .eq('booking_date', newDate)
      .eq('booking_time', targetTimeWithSec)
      .eq('service_id', booking.service_id)
      .neq('status', 'cancelled')
      .neq('id', bookingId)

    const others = (conflicts ?? []) as Array<{ id: string; number_of_people: number }>

    if (isShared) {
      const otherGuests = others.reduce((a, b) => a + b.number_of_people, 0)
      if (otherGuests + booking.number_of_people > maxCapacity) {
        return {
          ok: false,
          reason: 'slot_unavailable',
          detail: `shared slot has ${maxCapacity - otherGuests} seat(s) remaining, party is ${booking.number_of_people}`,
        }
      }
    } else if (others.length > 0) {
      return {
        ok: false,
        reason: 'slot_unavailable',
        detail: 'exclusive slot already booked',
      }
    }
  }

  const rescheduleNote = `[Caye reschedule] ${booking.booking_date} ${existingTime} → ${newDate} ${targetTime}`
  const noteWithLog = booking.notes
    ? `${booking.notes}\n\n${rescheduleNote}`
    : rescheduleNote

  const updates: Record<string, unknown> = {
    booking_date: newDate,
    booking_time: targetTimeWithSec,
    notes: noteWithLog,
  }
  if (newDurationMinutes && newDurationMinutes > 0) {
    updates.duration_minutes = newDurationMinutes
  }

  const { error: updErr } = await supabase
    .from('bookings')
    .update(updates)
    .eq('id', bookingId)

  if (updErr) return { ok: false, reason: 'db_error', detail: updErr.message }

  // Calendar upsert fire-and-forget — booking is already moved in DB,
  // calendar sync failure is recoverable manually.
  syncBookingToCalendar(workspaceId, bookingId, 'upsert').catch(err =>
    console.error('[caye-reply] reschedule calendar sync failed:', err)
  )

  return {
    ok: true,
    booking_id: bookingId,
    new_date: newDate,
    new_time: targetTime,
    time_was_preserved,
    hours_until_original_booking: gate.hoursUntilBooking,
  }
}

// ── end reschedule_booking ──────────────────────────────────────────────────

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

  // Fetch the workspace's business links + timezone in one query. Links
  // are non-fatal (empty = no BUSINESS LINKS block). Timezone is needed
  // for the cancel/reschedule policy gate so Caye doesn't misjudge the
  // 48h window for workspaces outside Nassau.
  let businessLinks: BusinessLinks | undefined
  let workspaceTimezone = 'America/Nassau' // sane default
  const { data: workspaceRow } = await supabase
    .from('customers')
    .select('booking_url, website_url, timezone')
    .eq('id', inbound.workspaceId)
    .maybeSingle()
  if (workspaceRow) {
    if (workspaceRow.booking_url || workspaceRow.website_url) {
      businessLinks = {
        booking_url: workspaceRow.booking_url,
        website_url: workspaceRow.website_url,
      }
    }
    if (workspaceRow.timezone) workspaceTimezone = workspaceRow.timezone
  }

  // If this conversation is linked to a contact, look up their style profile
  // + operational facts so Caye can mirror their energy AND avoid re-asking
  // for things already on file. Fetch is non-fatal.
  let contactProfile: ContactStyleProfile | undefined
  let contactFacts: CustomerFacts | undefined
  if (inbound.conversationId) {
    const { data: convRow } = await supabase
      .from('unified_conversations')
      .select('contact_id')
      .eq('id', inbound.conversationId)
      .maybeSingle()
    if (convRow?.contact_id) {
      const { data: contactRow } = await supabase
        .from('contacts')
        .select('ai_contact_profile, ai_contact_facts')
        .eq('id', convRow.contact_id)
        .maybeSingle()
      contactProfile =
        (contactRow?.ai_contact_profile as ContactStyleProfile | null) ?? undefined
      contactFacts =
        (contactRow?.ai_contact_facts as CustomerFacts | null) ?? undefined
    }
  }

  // Returning-customer history. Match on sender email + workspace. Skipped
  // entirely when we don't have an email (DM channels with no captured
  // address) — those contacts are handled when WhatsApp/IG/Messenger get
  // real per-workspace connections. Non-fatal on error: empty history just
  // means Caye treats them as a first-timer (the existing behaviour).
  let customerHistory: CustomerHistorySummary | undefined
  const lookupEmail = inbound.senderEmail?.trim().toLowerCase()
  if (lookupEmail) {
    const { data: bookingRows } = await supabase
      .from('bookings')
      .select('booking_date, status, number_of_people, service:booking_services(name)')
      .eq('user_id', inbound.workspaceId)
      .ilike('customer_email', lookupEmail)
    if (bookingRows && bookingRows.length > 0) {
      type Row = {
        booking_date: string
        status: string
        number_of_people: number
        service: { name: string }[] | null
      }
      const rows = bookingRows as unknown as Row[]
      const historyRows: BookingHistoryRow[] = rows.map(r => ({
        booking_date: r.booking_date,
        service_name: r.service?.[0]?.name ?? null,
        status: r.status,
        number_of_people: r.number_of_people,
      }))
      customerHistory = summarizeBookingHistory(historyRows)
    }
  }

  // Classify the inbound so buildSystem can append a situational tone
  // hint. Cheap regex/keyword pass — no API call. Returns null on
  // uncertainty (default tone takes over).
  const { category: inboundCategory } = classifyInbound(
    inbound.body,
    inbound.subject ?? ''
  )

  const system = buildSystem(
    systemPrompt,
    voiceProfile,
    contactProfile,
    contactFacts,
    businessLinks,
    customerHistory,
    inboundCategory,
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
        const input = tool.input as { reason: string; note: string; proposed_reply?: string }
        const draft = input.proposed_reply?.trim() || undefined
        // Identity guard the proposed draft too — never surface a draft that
        // would have been blocked from sending.
        const draftLeak = draft ? detectIdentityLeak(draft) : null
        terminal = {
          action: 'hold',
          reason: input.reason,
          note: input.note,
          proposedReply: draftLeak ? undefined : draft,
        }
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
      } else if (tool.name === 'find_bookings') {
        const input = tool.input as { customer_email?: string; customer_name?: string }
        const result = await findBookings(inbound.workspaceId, input)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
        })
      } else if (tool.name === 'cancel_booking') {
        const input = tool.input as { booking_id: string; reason?: string }
        const result = await cancelBookingFromCaye(
          inbound.workspaceId,
          input.booking_id,
          workspaceTimezone,
          input.reason
        )
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
          is_error: !result.ok,
        })
      } else if (tool.name === 'reschedule_booking') {
        const input = tool.input as {
          booking_id: string
          new_date: string
          new_time?: string
          duration_minutes?: number
        }
        const result = await rescheduleBookingFromCaye(
          inbound.workspaceId,
          input.booking_id,
          input.new_date,
          input.new_time,
          input.duration_minutes,
          workspaceTimezone
        )
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
          is_error: !result.ok,
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
