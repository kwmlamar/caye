/**
 * GET /api/caye/tour-reminder/cron
 *
 * Daily cron — sends guests a logistics reminder the day before and the
 * morning of their tour. Guest-facing only; the operator sees who's
 * touring today/tomorrow via the existing morning-briefing digest, so
 * this doesn't also ping the operator (would be a duplicate signal).
 *
 * Scoped to status='confirmed' bookings only — there's no payment_status
 * column (Bimini's real rails, cash/Zelle/card, have nothing to detect),
 * so 'confirmed' is the closest existing proxy for "this is really
 * happening," and it avoids reminding someone about a still-tentative
 * 'pending' booking.
 *
 * day_before_reminder_sent_at / day_of_reminder_sent_at are one-shot
 * markers (not repeating, unlike escalation-followup) — a booking gets
 * at most one of each.
 *
 * Reminder copy only states facts already on the booking row (service
 * name, date, time) — no invented pickup/logistics detail, consistent
 * with Caye never inventing facts she doesn't have.
 *
 * Authenticated via CRON_SECRET, same header contract as the other
 * cron routes.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { dispatchOperatorReply } from '@/lib/whatsapp/channel-dispatch'
import { BOOKING_WITH_SERVICE_PRICE_SELECT, type ServiceJoin } from '@/lib/caye-agent/tools/_revenue'

interface BookingRow {
  id: string
  customer_name: string | null
  booking_date: string
  booking_time: string | null
  conversation_id: string | null
  service: ServiceJoin[] | null
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    const legacy = request.headers.get('x-cron-secret')
    if (auth !== `Bearer ${secret}` && legacy !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const today = new Date()
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000)
  const todayStr = today.toISOString().slice(0, 10)
  const tomorrowStr = tomorrow.toISOString().slice(0, 10)

  const summary = { day_before_sent: 0, day_of_sent: 0, skipped: 0 }

  await processBatch({
    dateStr: tomorrowStr,
    column: 'day_before_reminder_sent_at',
    framing: 'tomorrow',
    onSent: () => summary.day_before_sent++,
    onSkipped: () => summary.skipped++,
  })

  await processBatch({
    dateStr: todayStr,
    column: 'day_of_reminder_sent_at',
    framing: 'today',
    onSent: () => summary.day_of_sent++,
    onSkipped: () => summary.skipped++,
  })

  return NextResponse.json(summary)
}

async function processBatch(args: {
  dateStr: string
  column: 'day_before_reminder_sent_at' | 'day_of_reminder_sent_at'
  framing: 'tomorrow' | 'today'
  onSent: () => void
  onSkipped: () => void
}): Promise<void> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('bookings')
    .select(
      `id, customer_name, booking_date, booking_time, conversation_id, ${BOOKING_WITH_SERVICE_PRICE_SELECT}`
    )
    .eq('status', 'confirmed')
    .eq('booking_date', args.dateStr)
    .is(args.column, null)
    .limit(200)

  if (error) {
    console.error(`[tour-reminder] fetch failed (${args.column}):`, error)
    return
  }

  for (const row of (data ?? []) as unknown as BookingRow[]) {
    if (!row.conversation_id) {
      args.onSkipped()
      continue
    }

    const service = row.service?.[0] ?? null
    const timeLabel = row.booking_time ? ` at ${row.booking_time.slice(0, 5)}` : ''
    const dayWord = args.framing === 'tomorrow' ? 'tomorrow' : 'today'

    const body =
      `Hi ${row.customer_name ?? 'there'},\n\n` +
      `Quick reminder — your ${service?.name ?? 'tour'} is ${dayWord}${timeLabel}. Looking forward to it!\n\n` +
      `Reply here if anything's changed on your end.`

    try {
      await dispatchOperatorReply(row.conversation_id, body, 'caye-dashboard')
      await supabase
        .from('bookings')
        .update({ [args.column]: new Date().toISOString() })
        .eq('id', row.id)
      args.onSent()
    } catch (err) {
      console.error(`[tour-reminder] send failed for booking ${row.id}:`, err)
      args.onSkipped()
    }
  }
}
