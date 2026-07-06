/**
 * GET /api/caye/driver-reminder/cron
 *
 * Karenda: "is there a way to send a reminder to the drivers pertaining
 * to their pick up time. like an hour before" (2026-07-05, grilled
 * same day). Distinct from tour-reminder/cron (guest-facing, daily
 * granularity) — this needs to catch a ~1-hour window, so it runs on a
 * tight cadence (intended: every 15 minutes) and checks a window rather
 * than an exact match so a slightly-late tick doesn't skip anyone.
 *
 * One-shot per assignment via driver_reminder_sent_at — never re-fires.
 * Reminder text is deterministic (guest name, tour, time) — same
 * never-invent-facts rule as tour-reminder/cron and the notify_driver
 * dispatch tool.
 *
 * Authenticated via CRON_SECRET, same header contract as the other cron
 * routes. Scheduling (the actual 15-min interval) is configured wherever
 * tour-reminder/cron's schedule lives (Vercel cron / external scheduler,
 * not in-repo) — add this route alongside it.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { sendTemplateWhatsApp } from '@/lib/whatsapp/outbound'

const WINDOW_START_MIN = 45
const WINDOW_END_MIN = 75

interface AssignmentRow {
  id: string
  driver_phone: string
  driver_name: string | null
  booking_id: string
  bookings: {
    customer_name: string | null
    booking_date: string
    booking_time: string | null
    booking_services: { name: string | null } | { name: string | null }[] | null
  } | null
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

  const supabase = createServiceClient()
  const now = new Date()
  const todayISO = now.toISOString().slice(0, 10)

  const { data, error } = await supabase
    .from('booking_driver_assignments')
    .select(
      `id, driver_phone, driver_name, booking_id,
       bookings!inner(customer_name, booking_date, booking_time, booking_services(name))`
    )
    .is('driver_reminder_sent_at', null)
    .eq('bookings.booking_date', todayISO)
    .limit(200)

  if (error) {
    console.error('[driver-reminder] fetch failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let sent = 0
  let skipped = 0

  for (const row of (data ?? []) as unknown as AssignmentRow[]) {
    const booking = row.bookings
    if (!booking?.booking_time) {
      skipped++
      continue
    }

    const [h, m] = booking.booking_time.split(':').map(Number)
    const pickupAt = new Date(now)
    pickupAt.setHours(h, m, 0, 0)
    const minutesUntil = (pickupAt.getTime() - now.getTime()) / 60000

    if (minutesUntil < WINDOW_START_MIN || minutesUntil > WINDOW_END_MIN) {
      skipped++
      continue
    }

    const service = Array.isArray(booking.booking_services)
      ? booking.booking_services[0]
      : booking.booking_services
    const tourName = service?.name ?? 'tour'
    const timeLabel = booking.booking_time.slice(0, 5)

    const result = await sendTemplateWhatsApp(
      row.driver_phone,
      'caye_driver_reminder',
      [row.driver_name ?? 'there', booking.customer_name ?? 'your guest', tourName, timeLabel],
      `driver-reminder-${row.id}`
    )

    if (result.status === 'sent') {
      await supabase
        .from('booking_driver_assignments')
        .update({ driver_reminder_sent_at: new Date().toISOString() })
        .eq('id', row.id)
      sent++
    } else {
      console.error(`[driver-reminder] send failed for assignment ${row.id}:`, result.error)
      skipped++
    }
  }

  return NextResponse.json({ sent, skipped })
}
