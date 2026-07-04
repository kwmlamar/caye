import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { dispatchOperatorReply } from '@/lib/whatsapp/channel-dispatch'
import type { Tool } from '../types'
import { bookingRevenue, BOOKING_WITH_SERVICE_PRICE_SELECT, type ServiceJoin } from '../_revenue'

interface SendPaymentConfirmationInput {
  customer_name: string
}

interface CandidateBooking {
  id: string
  customer_name: string | null
  booking_date: string
  booking_time: string | null
  number_of_people: number | null
  conversation_id: string | null
  status: string
  payment_confirmed_at: string | null
  service: ServiceJoin[] | null
}

/**
 * Operator says "<name> paid" (or similar) in back-office chat — the
 * operator's own statement IS the authorization, unlike send_reply/
 * confirm_booking which gate on a separate "yes/send" turn. So this is
 * write-low (immediate), not write-high. The only gate that matters here
 * is disambiguation: never send to a guessed booking. The confirmation
 * body itself is built deterministically from booking + service data
 * (not LLM-freeform), same reasoning as forced-escalation's templates —
 * mechanical construction from known facts, not invented content.
 *
 * No general payment_status exists (Bimini's real rails — cash/Zelle/
 * card — have nothing to detect), so this tool is how "paid" gets
 * recorded at all: operator-attested via payment_confirmed_at.
 */
export const sendPaymentConfirmation: Tool<SendPaymentConfirmationInput> = {
  name: 'send_payment_confirmation',
  description:
    "Send a customer a post-payment confirmation (tour, date, price, logistics) and mark the booking paid. Use when the operator tells you a customer paid (e.g. \"Jeff paid\", \"mark Maria's booking as paid and confirm her\"). Looks up the booking by customer name — if more than one booking matches or none do, this tool returns the candidates instead of sending anything; ask the operator to clarify rather than guessing. Never call this speculatively — only when the operator has stated someone paid.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      customer_name: {
        type: 'string',
        description: "The customer's name (or partial name) as the operator said it.",
      },
    },
    required: ['customer_name'],
  },

  async execute(args, ctx) {
    const name = args.customer_name.trim()
    if (!name) return { ok: false, error: 'customer_name cannot be empty' }

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('bookings')
      .select(
        `id, customer_name, booking_date, booking_time, number_of_people, conversation_id, status, payment_confirmed_at, ${BOOKING_WITH_SERVICE_PRICE_SELECT}`
      )
      .eq('user_id', ctx.workspaceId)
      .neq('status', 'cancelled')
      .ilike('customer_name', `%${name}%`)
      .order('booking_date', { ascending: false })
      .limit(10)

    if (error) return { ok: false, error: error.message }
    const candidates = (data ?? []) as unknown as CandidateBooking[]

    if (candidates.length === 0) {
      return {
        ok: false,
        error: `No booking found matching "${name}". Ask the operator for the exact name or a date to narrow it down.`,
      }
    }

    if (candidates.length > 1) {
      return {
        ok: false,
        error: `Multiple bookings match "${name}" — ask the operator which one before sending anything.`,
        data: {
          candidates: candidates.map((c) => ({
            booking_id: c.id,
            customer_name: c.customer_name,
            date: c.booking_date,
            service: c.service?.[0]?.name ?? null,
            already_confirmed: Boolean(c.payment_confirmed_at),
          })),
        },
      }
    }

    const booking = candidates[0]
    if (!booking.conversation_id) {
      return {
        ok: false,
        error: `${booking.customer_name}'s booking has no linked conversation thread — can't send a confirmation. Tell the operator to reach the customer directly.`,
      }
    }
    if (booking.payment_confirmed_at) {
      return {
        ok: false,
        error: `${booking.customer_name}'s payment was already confirmed on ${booking.payment_confirmed_at.slice(0, 10)}. Not sending a duplicate — tell the operator if this is a different payment.`,
      }
    }

    const service = booking.service?.[0] ?? null
    const price = bookingRevenue({
      servicePrice: service?.price,
      priceType: service?.price_type,
      guests: booking.number_of_people,
    })
    const dateLabel = new Date(`${booking.booking_date}T00:00:00`).toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    })
    const timeLabel = booking.booking_time ? ` at ${booking.booking_time.slice(0, 5)}` : ''
    const priceLabel = price > 0 ? `$${price.toFixed(2)}` : 'the agreed amount'

    const body =
      `Hi ${booking.customer_name ?? 'there'},\n\n` +
      `Thanks so much — we've received your payment (${priceLabel}) for ${service?.name ?? 'your tour'} on ${dateLabel}${timeLabel}. You're all set!\n\n` +
      `We'll follow up with any final logistics before your tour date. If anything changes on your end, just reply here.\n\n` +
      `Looking forward to it!`

    try {
      const result = await dispatchOperatorReply(booking.conversation_id, body, 'caye-dashboard')

      const now = new Date().toISOString()
      await supabase
        .from('bookings')
        .update({
          payment_confirmed_at: now,
          status: booking.status === 'pending' ? 'confirmed' : booking.status,
        })
        .eq('id', booking.id)

      return {
        ok: true,
        data: {
          booking_id: booking.id,
          customer_name: booking.customer_name,
          channel: result.channelType,
          sent: true,
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Send failed: ${msg}` }
    }
  },
}
