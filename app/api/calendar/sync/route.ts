/**
 * POST /api/calendar/sync
 *
 * Pushes a booking change to the workspace's external calendar (currently Zoho).
 * Called by BookingModal after every save / cancel.
 *
 * Body: { booking_id: string, action: 'upsert' | 'delete' }
 *
 * upsert  → if booking has zoho_event_id, update; else create + store id
 * delete  → if booking has zoho_event_id, delete on Zoho + clear local id
 *
 * No-op (200 success) if the user has no Zoho account or sync_calendar is off.
 * Failures are logged but returned as 200 with { synced: false, reason } so the
 * caller's booking save isn't rolled back.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import {
  createZohoCalendarEvent,
  updateZohoCalendarEvent,
  deleteZohoCalendarEvent,
  type BookingEventInput,
} from '@/lib/zoho-calendar'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return NextResponse.json({ error: 'Missing auth token' }, { status: 401 })

  const supabase = createServiceClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { booking_id?: string; action?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { booking_id, action } = body
  if (!booking_id || (action !== 'upsert' && action !== 'delete')) {
    return NextResponse.json({ error: 'booking_id and action (upsert|delete) required' }, { status: 400 })
  }

  // Load booking + verify ownership
  const { data: booking, error: bkErr } = await supabase
    .from('bookings')
    .select('id, user_id, customer_name, booking_date, booking_time, number_of_people, notes, zoho_event_id, service:booking_services(name, duration_minutes)')
    .eq('id', booking_id)
    .single()

  if (bkErr || !booking) {
    return NextResponse.json({ error: 'Booking not found' }, { status: 404 })
  }
  if (booking.user_id !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Check the workspace's Zoho account + sync toggle
  const { data: account } = await supabase
    .from('connected_accounts')
    .select('sync_calendar')
    .eq('user_id', user.id)
    .eq('channel_type', 'email')
    .eq('is_active', true)
    .maybeSingle()

  if (!account) {
    return NextResponse.json({ synced: false, reason: 'No active Zoho email account' })
  }
  if (!account.sync_calendar) {
    return NextResponse.json({ synced: false, reason: 'Calendar sync disabled' })
  }

  const serviceArr = booking.service as { name: string; duration_minutes: number }[] | null
  const eventInput: BookingEventInput = {
    customerName: booking.customer_name,
    serviceName: serviceArr?.[0]?.name ?? null,
    bookingDate: booking.booking_date,
    bookingTime: booking.booking_time,
    durationMinutes: serviceArr?.[0]?.duration_minutes ?? 120,
    numberOfPeople: booking.number_of_people,
    notes: booking.notes,
  }

  try {
    if (action === 'delete') {
      if (booking.zoho_event_id) {
        await deleteZohoCalendarEvent(user.id, booking.zoho_event_id)
        await supabase.from('bookings').update({ zoho_event_id: null }).eq('id', booking.id)
      }
      return NextResponse.json({ synced: true, action: 'delete' })
    }

    // upsert
    if (booking.zoho_event_id) {
      await updateZohoCalendarEvent(user.id, booking.zoho_event_id, eventInput)
      return NextResponse.json({ synced: true, action: 'update', event_id: booking.zoho_event_id })
    } else {
      const eventId = await createZohoCalendarEvent(user.id, eventInput)
      await supabase.from('bookings').update({ zoho_event_id: eventId }).eq('id', booking.id)
      return NextResponse.json({ synced: true, action: 'create', event_id: eventId })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[calendar/sync] ${action} failed for booking ${booking.id}:`, msg)
    return NextResponse.json({ synced: false, reason: msg })
  }
}
