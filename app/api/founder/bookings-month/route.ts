/**
 * GET /api/founder/bookings-month?workspaceId=<uuid>&monthOffset=<int>
 *
 * Founder-only per-workspace bookings for a full calendar month — backs
 * CommandCalendar's month view. Deliberately its own lean route rather
 * than widening /api/founder/command-overview's 7-day window: that route
 * also pulls a 7-day LLM cost trend and a workspace mute check on every
 * call, neither of which a month grid needs, and widening it would
 * multiply that unrelated work by ~4-5x per month-view fetch.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS — same audited
 * service-role path as command-overview (see that route's comment on why
 * RLS isn't trusted directly for bookings/escalations here).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  }

  // Calendar months away from the current one — 0 = this month.
  const monthOffsetParam = req.nextUrl.searchParams.get('monthOffset')
  const monthOffset = monthOffsetParam ? parseInt(monthOffsetParam, 10) || 0 : 0

  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user || !isFounderUserId(user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const supabase = createServiceClient()

  // First-of-month, UTC, shifted by whole months — matches
  // command-overview's UTC-anchored week math so the two never disagree
  // on what "today" falls under near a day boundary.
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1))
  const nextMonthStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1))

  const [
    { data: bookingsRows, error: bookingsErr },
    { data: escalations, error: escErr },
  ] = await Promise.all([
    supabase
      .from('bookings')
      .select('id, customer_name, booking_date, booking_time, status, number_of_people, payment_confirmed_at, conversation_id, service:booking_services(name)')
      .eq('user_id', workspaceId)
      .gte('booking_date', monthStart.toISOString().slice(0, 10))
      .lt('booking_date', nextMonthStart.toISOString().slice(0, 10))
      .neq('status', 'cancelled')
      .order('booking_date', { ascending: true }),
    // Same "20 most recent" scan command-overview uses to flag bookings
    // with an open escalation — not month-scoped, since an escalation for
    // a booking outside the requested month isn't this route's concern.
    supabase
      .from('caye_escalations')
      .select('conversation_id, owner_responded_at, expired_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  if (bookingsErr) return NextResponse.json({ error: bookingsErr.message }, { status: 500 })
  if (escErr) return NextResponse.json({ error: escErr.message }, { status: 500 })

  // Same "open escalation" definition as command-overview's booking flag.
  const openEscalationConversationIds = new Set(
    (escalations ?? [])
      .filter((e) => !e.owner_responded_at && !e.expired_at && e.conversation_id)
      .map((e) => e.conversation_id as string)
  )

  interface BookingRow {
    id: string
    customer_name: string
    booking_date: string
    booking_time: string
    status: string
    number_of_people: number
    payment_confirmed_at: string | null
    conversation_id: string | null
    service: { name: string }[] | { name: string } | null
  }

  const bookings = ((bookingsRows ?? []) as unknown as BookingRow[]).map((b) => ({
    id: b.id,
    customer_name: b.customer_name,
    booking_date: b.booking_date,
    booking_time: b.booking_time,
    status: b.status,
    number_of_people: b.number_of_people,
    payment_confirmed: !!b.payment_confirmed_at,
    conversation_id: b.conversation_id,
    service_name: Array.isArray(b.service) ? (b.service[0]?.name ?? null) : (b.service?.name ?? null),
    has_open_escalation: !!b.conversation_id && openEscalationConversationIds.has(b.conversation_id),
  }))

  return NextResponse.json({
    bookings,
    month_start: monthStart.toISOString().slice(0, 10),
    month_offset: monthOffset,
  })
}
