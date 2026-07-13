import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'
import type { ToolResult } from '../types'

/**
 * Look up a booking by id, scoped to the workspace. Returns the row
 * (with conversation_id and customer info) or a structured error.
 */
export async function findOwnedBooking(
  supabase: ReturnType<typeof createServiceClient>,
  bookingId: string,
  workspaceId: string
): Promise<
  | { ok: true; booking: BookingRow }
  | { ok: false; error: string }
> {
  const { data, error } = await supabase
    .from('bookings')
    .select(
      'id, status, booking_date, booking_time, customer_name, conversation_id, service_id, number_of_people'
    )
    .eq('id', bookingId)
    .eq('user_id', workspaceId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'Booking not found in this workspace' }
  return { ok: true, booking: data as BookingRow }
}

export interface BookingRow {
  id: string
  status: string
  booking_date: string
  booking_time: string | null
  customer_name: string | null
  conversation_id: string | null
  service_id: string | null
  number_of_people: number | null
}

/**
 * Send a customer-facing notification to a booking's conversation
 * thread. Returns a ToolResult-compatible shape if the send fails,
 * or null on success. Skips entirely when notify_customer is false
 * or no body is provided.
 */
export async function maybeNotifyCustomer(args: {
  conversationId: string | null
  notify: boolean | undefined
  body: string | undefined
}): Promise<{ sent: boolean; channel?: string; error?: string }> {
  if (args.notify === false) return { sent: false }
  if (!args.body || !args.body.trim()) return { sent: false }
  if (!args.conversationId) {
    return { sent: false, error: 'Booking has no linked conversation thread' }
  }
  try {
    const { dispatchOperatorReply } = await import(
      '@/lib/whatsapp/channel-dispatch'
    )
    const result = await dispatchOperatorReply(
      args.conversationId,
      args.body.trim(),
      'caye-dashboard'
    )
    return { sent: true, channel: result.channelType }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { sent: false, error: msg }
  }
}

/**
 * Shared confirmation-flow boilerplate for the high-risk tool prompts.
 * Each booking-mutating tool's description starts with this so the
 * model treats them all the same way.
 *
 * The gate is enforced in code (gateHighRisk, #64), not just by this
 * text: the FIRST call with a given set of args always only stages the
 * action and returns it un-executed. Call it as soon as you have the
 * real args resolved — don't wait to "decide" whether to call it. Relay
 * the returned summary to the operator and ask them to confirm. Once
 * they reply affirmatively in a NEW message, call this same tool again
 * with the SAME arguments to actually run it. If the operator changes
 * any detail, call again with the corrected arguments — that starts a
 * fresh confirmation.
 */
export const HIGH_RISK_CONFIRMATION_PREAMBLE =
  'HIGH-RISK — staged, not immediate. The first call with a given set of arguments only stages the action (nothing happens yet); it returns a summary for you to relay to the operator. Call it again with the SAME arguments after the operator confirms in their next message to actually run it.'

export const NOTIFY_BODY_DESCRIPTION =
  "The exact customer-facing notification text. Sent as-is to the customer's thread via their native channel. Compose in the operator's voice using the VOICE PROFILE; this text has already been approved by the operator in the prior turn. Leave empty + set notify_customer=false to make the booking change silently without notifying the customer."

export const NOTIFY_CUSTOMER_DESCRIPTION =
  "Whether to notify the customer. Defaults to true. Set false when the operator handled the conversation directly (e.g., 'I already told her in person')."
