/**
 * zoho-inbound-sync.ts
 *
 * Pulls events from a workspace's Zoho Calendar and mirrors them into the
 * bookings table. Companion to lib/calendar-sync.ts (which pushes outbound).
 *
 * For each workspace with sync_calendar enabled:
 *   1. Fetch Zoho events in the window [today - 1d, today + 90d]
 *   2. For each event:
 *      - Find existing booking by zoho_event_id → update if changed
 *      - Else find a matching un-linked booking (same date/time/name) → link
 *      - Else insert a new booking with conversation_id=null, status=confirmed,
 *        customer_name derived from event title
 *   3. Reconcile deletes: any booking in the window with a zoho_event_id no
 *      longer present in the fetch is set to status='cancelled'
 *
 * All-day events are skipped — bookings have a fixed time/duration shape.
 */

import 'server-only'
import { createServiceClient } from './supabase-server'
import { listZohoCalendarEvents, type ZohoEventSummary } from './zoho-calendar'

interface LocalBookingRow {
  id: string
  customer_name: string
  booking_date: string
  booking_time: string
  number_of_people: number
  notes: string | null
  status: string
  zoho_event_id: string | null
}

export interface InboundSyncStats {
  workspaceId: string
  fetched: number
  inserted: number
  updated: number
  linked: number
  cancelled: number
  skipped: number
  error?: string
}

const WINDOW_DAYS_BACK = 1
const WINDOW_DAYS_FORWARD = 90

function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * Caye writes outbound titles as 'ServiceName — CustomerName (Npeople)' or
 * 'CustomerName (Npeople guests)'. Parse those back so the round-trip
 * (Caye → Zoho → poll → booking) doesn't mangle the customer name.
 *
 * For external events that don't match those patterns, returns the raw title.
 */
function parseCustomerFromTitle(title: string): string {
  const dashSplit = title.split('—')
  const right = dashSplit.length > 1 ? dashSplit.slice(1).join('—').trim() : title.trim()
  // Strip trailing " (N)" or " (N guests)"
  const cleaned = right.replace(/\s*\(\d+\s*(guests?)?\)\s*$/i, '').trim()
  return cleaned || title
}

function bookingMatchesEvent(b: LocalBookingRow, ev: ZohoEventSummary): boolean {
  return (
    b.booking_date === ev.startDate &&
    b.booking_time === ev.startTime &&
    b.customer_name.trim().toLowerCase() === parseCustomerFromTitle(ev.title).toLowerCase()
  )
}

function bookingNeedsUpdate(b: LocalBookingRow, ev: ZohoEventSummary): boolean {
  if (b.booking_date !== ev.startDate) return true
  if (b.booking_time !== ev.startTime) return true
  const evCustomer = parseCustomerFromTitle(ev.title)
  if (b.customer_name.trim() !== evCustomer.trim()) return true
  return false
}

export async function syncZohoEventsToBookings(workspaceId: string): Promise<InboundSyncStats> {
  const stats: InboundSyncStats = {
    workspaceId,
    fetched: 0,
    inserted: 0,
    updated: 0,
    linked: 0,
    cancelled: 0,
    skipped: 0,
  }

  const supabase = createServiceClient()

  // Gate: account active AND sync_calendar on
  const { data: account } = await supabase
    .from('connected_accounts')
    .select('id, sync_calendar')
    .eq('user_id', workspaceId)
    .eq('channel_type', 'email')
    .eq('is_active', true)
    .maybeSingle()

  if (!account || !account.sync_calendar) {
    stats.error = 'Sync disabled or no active Zoho account'
    return stats
  }

  const today = new Date().toISOString().slice(0, 10)
  const fromDate = addDaysISO(today, -WINDOW_DAYS_BACK)
  const toDate = addDaysISO(today, WINDOW_DAYS_FORWARD)

  let events: ZohoEventSummary[]
  try {
    events = await listZohoCalendarEvents(workspaceId, fromDate, toDate)
  } catch (err) {
    stats.error = err instanceof Error ? err.message : String(err)
    return stats
  }
  stats.fetched = events.length

  // Local bookings in the same window
  const { data: localRows } = await supabase
    .from('bookings')
    .select('id, customer_name, booking_date, booking_time, number_of_people, notes, status, zoho_event_id')
    .eq('user_id', workspaceId)
    .gte('booking_date', fromDate)
    .lte('booking_date', toDate)

  const local: LocalBookingRow[] = (localRows ?? []) as LocalBookingRow[]
  const localByZohoUid = new Map<string, LocalBookingRow>()
  const unlinkedLocal: LocalBookingRow[] = []
  for (const b of local) {
    if (b.zoho_event_id) localByZohoUid.set(b.zoho_event_id, b)
    else unlinkedLocal.push(b)
  }

  const zohoUidsSeen = new Set<string>()

  for (const ev of events) {
    if (ev.isAllDay) { stats.skipped++; continue }
    zohoUidsSeen.add(ev.uid)

    const existing = localByZohoUid.get(ev.uid)
    if (existing) {
      // Reactivate if previously cancelled (user un-deleted from Zoho)
      const payload: Record<string, unknown> = {}
      if (bookingNeedsUpdate(existing, ev)) {
        payload.booking_date = ev.startDate
        payload.booking_time = ev.startTime
        payload.customer_name = parseCustomerFromTitle(ev.title)
      }
      if (existing.status === 'cancelled') {
        payload.status = 'confirmed'
        payload.cancelled_at = null
      }
      if (Object.keys(payload).length > 0) {
        await supabase.from('bookings').update(payload).eq('id', existing.id)
        stats.updated++
      } else {
        stats.skipped++
      }
      continue
    }

    // Try to link to an existing un-linked booking (handles Caye→Zoho race
    // and manual local entries that happen to coincide with Zoho events).
    const match = unlinkedLocal.find(b => bookingMatchesEvent(b, ev))
    if (match) {
      await supabase
        .from('bookings')
        .update({ zoho_event_id: ev.uid })
        .eq('id', match.id)
      // Remove from candidate pool so the same booking can't be linked twice
      const idx = unlinkedLocal.indexOf(match)
      if (idx >= 0) unlinkedLocal.splice(idx, 1)
      stats.linked++
      continue
    }

    // Insert new booking from external Zoho event
    const customerName = parseCustomerFromTitle(ev.title)
    const { error: insertErr } = await supabase.from('bookings').insert({
      user_id: workspaceId,
      conversation_id: null,
      service_id: null,
      customer_name: customerName,
      customer_phone: null,
      customer_email: null,
      booking_date: ev.startDate,
      booking_time: ev.startTime,
      number_of_people: 1,
      status: 'confirmed',
      notes: ev.description?.slice(0, 500) || null,
      zoho_event_id: ev.uid,
    })
    if (insertErr) {
      console.error(`[zoho-inbound-sync] Insert failed for event ${ev.uid}:`, insertErr.message)
      stats.skipped++
    } else {
      stats.inserted++
    }
  }

  // Reconcile deletes are DISABLED until we've confirmed Zoho list is reliably
  // returning the user's events. The previous behavior mass-cancelled local
  // bookings whenever Zoho returned an empty (or wrong-calendar) response.
  // Re-enable behind a flag once we verify the fetch is correct.
  const RECONCILE_DELETES = false
  if (RECONCILE_DELETES && events.length > 0) {
    for (const [uid, booking] of localByZohoUid.entries()) {
      if (zohoUidsSeen.has(uid)) continue
      if (booking.status === 'cancelled') continue
      await supabase
        .from('bookings')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
        .eq('id', booking.id)
      stats.cancelled++
    }
  } else if (localByZohoUid.size > 0) {
    const unseen = [...localByZohoUid.values()].filter(
      b => !zohoUidsSeen.has(b.zoho_event_id ?? '') && b.status !== 'cancelled'
    )
    if (unseen.length > 0) {
      console.warn(
        `[zoho-inbound-sync] ${workspaceId}: reconcile disabled — would have cancelled ` +
          `${unseen.length} bookings whose Zoho events weren't in the fetch.`
      )
    }
  }

  return stats
}
