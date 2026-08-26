import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import { HIGH_RISK_CONFIRMATION_PREAMBLE } from './_booking-helpers'
import { bookingRevenue, BOOKING_WITH_SERVICE_PRICE_SELECT, type ServiceJoin } from '../_revenue'
import { createPaymentLink, ChargeAnywhereNotConfiguredError } from '@/lib/payments/chargeanywhere'
import { claimConversationExecution, completeConversationExecution, releaseConversationExecution, validateConversationExecution } from '@/lib/conversation-execution'

interface SendPaymentLinkInput {
  booking_id: string
  amount_override?: number
}

interface PaymentBookingRow {
  id: string
  customer_name: string | null
  booking_date: string
  number_of_people: number | null
  conversation_id: string | null
  status: string
  payment_link_sent_at: string | null
  payment_confirmed_at: string | null
  service: ServiceJoin[] | null
}

/**
 * Generates and sends a ChargeAnywhere payment link — the automated
 * replacement for Karenda manually creating one in ChargeAnywhere and
 * pasting it into the thread herself.
 *
 * lib/payments/chargeanywhere.ts is a scaffold: createPaymentLink always
 * throws ChargeAnywhereNotConfiguredError until real API credentials and
 * endpoint docs are wired in. This tool is built and registered now so
 * the booking-flow wiring (lookup, price calc, send, DB bookkeeping) is
 * ready — only the vendor call itself is pending.
 */
export const sendPaymentLink: Tool<SendPaymentLinkInput> = {
  name: 'send_payment_link',
  description: `Generate a ChargeAnywhere payment link for a booking and send it to the customer. ${HIGH_RISK_CONFIRMATION_PREAMBLE}

Use amount_override to send a deposit (e.g. Bimini's 50%-due-7-days-out policy) instead of the full tour price. Not yet wired to ChargeAnywhere's real API — returns a clear error telling the operator it needs setup, rather than failing silently.`,
  risk: 'high',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      booking_id: {
        type: 'string',
        description: 'The booking_id from get_calendar / get_recent_bookings / get_customer_history.',
      },
      amount_override: {
        type: 'number',
        description: 'Send this amount instead of the full computed tour price — e.g. a deposit. Omit to charge the full price.',
      },
    },
    required: ['booking_id'],
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('bookings')
      .select(
        `id, customer_name, booking_date, number_of_people, conversation_id, status, payment_link_sent_at, payment_confirmed_at, ${BOOKING_WITH_SERVICE_PRICE_SELECT}`
      )
      .eq('id', args.booking_id)
      .eq('user_id', ctx.workspaceId)
      .maybeSingle()

    if (error) return { ok: false, error: error.message }
    if (!data) return { ok: false, error: 'Booking not found in this workspace' }
    const booking = data as unknown as PaymentBookingRow

    if (booking.status === 'cancelled') {
      return { ok: false, error: 'Booking is cancelled — cannot send a payment link for it.' }
    }
    if (booking.payment_confirmed_at) {
      return {
        ok: false,
        error: `${booking.customer_name}'s payment was already confirmed on ${booking.payment_confirmed_at.slice(0, 10)}. Not sending another link.`,
      }
    }
    if (!booking.conversation_id) {
      return {
        ok: false,
        error: `${booking.customer_name}'s booking has no linked conversation thread — can't deliver a payment link.`,
      }
    }

    const service = booking.service?.[0] ?? null
    const fullPrice = bookingRevenue({
      servicePrice: service?.price,
      priceType: service?.price_type,
      guests: booking.number_of_people,
    })
    const amount = args.amount_override ?? fullPrice
    if (!amount || amount <= 0) {
      return {
        ok: false,
        error: `Couldn't determine an amount to charge — ${
          service ? 'check the service price' : 'this booking has no linked service'
        }. Pass amount_override to set one explicitly.`,
      }
    }

    let link
    try {
      link = await createPaymentLink({
        amount,
        description: `${service?.name ?? 'Tour'} — ${booking.booking_date}`,
        customerName: booking.customer_name ?? 'Customer',
      })
    } catch (err) {
      if (err instanceof ChargeAnywhereNotConfiguredError) {
        return {
          ok: false,
          error:
            "ChargeAnywhere isn't connected yet — no API credentials on file. Tell the operator this needs Lamar to finish the ChargeAnywhere integration.",
        }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `ChargeAnywhere request failed: ${msg}` }
    }

    const body =
      `Hi ${booking.customer_name ?? 'there'},\n\n` +
      `Here's your payment link for ${service?.name ?? 'your tour'} on ${booking.booking_date}: ${link.url}\n\n` +
      `Once it clears we'll send your confirmation and logistics.`

    let claimId: string | null = null
    try {
      const execution = await claimConversationExecution({
        workspaceId: ctx.workspaceId,
        conversationId: booking.conversation_id,
        holder: 'operator_caye',
        idempotencyKey: `payment-link:${booking.id}`,
        reason: 'payment link',
      })
      if (!execution.ok) return { ok: false, status: 'CONFLICT', error: `Customer conversation is being handled by ${execution.blockedBy}; payment link was not sent.` }
      claimId = execution.claim.id
      const validated = await validateConversationExecution({ claimId: execution.claim.id })
      if (!validated.ok) return { ok: false, status: 'CONFLICT', error: `Customer conversation changed before payment link could be sent (${validated.reason}). Nothing was sent.` }

      const { dispatchOperatorReply } = await import('@/lib/whatsapp/channel-dispatch')
      const result = await dispatchOperatorReply(booking.conversation_id, body, 'caye-dashboard')
      await completeConversationExecution(claimId)

      const now = new Date().toISOString()
      await supabase
        .from('bookings')
        .update({
          payment_link_sent_at: now,
          payment_link_url: link.url,
          payment_link_invoice_number: link.invoiceNumber,
        })
        .eq('id', booking.id)

      return {
        ok: true,
        data: {
          booking_id: booking.id,
          customer_name: booking.customer_name,
          amount,
          invoice_number: link.invoiceNumber,
          channel: result.channelType,
          sent: true,
        },
      }
    } catch (err) {
      if (claimId) await releaseConversationExecution(claimId).catch(() => undefined)
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Link created but send failed: ${msg}` }
    }
  },
}
