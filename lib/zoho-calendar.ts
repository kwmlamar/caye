/**
 * zoho-calendar.ts
 *
 * Zoho Calendar event helpers — create, update, delete events on the user's
 * default calendar. Used to mirror Caye bookings into the owner's Zoho calendar.
 *
 * The default calendar ID is cached in connected_accounts.metadata.zoho_calendar_id
 * to avoid an extra round trip on every sync.
 */

import 'server-only'
import { getZohoContext } from './zoho-token'
import { createServiceClient } from './supabase-server'

function calendarBase(apiDomain: string): string {
  // www.zohoapis.com -> calendar.zoho.com
  return (apiDomain || 'https://www.zohoapis.com').replace('www.zohoapis', 'calendar.zoho')
}

export interface BookingEventInput {
  customerName: string
  serviceName: string | null
  bookingDate: string   // 'YYYY-MM-DD'
  bookingTime: string   // 'HH:MM:SS'
  durationMinutes: number
  numberOfPeople: number
  notes: string | null
}

/**
 * Zoho's dateandtime format is 'YYYYMMDDTHHMMSSZ' (UTC).
 * Booking date+time are stored without TZ; assume UTC for now.
 */
function toZohoDateTime(dateISO: string, timeISO: string): string {
  const d = dateISO.replace(/-/g, '')
  const t = timeISO.slice(0, 8).replace(/:/g, '')
  return `${d}T${t}Z`
}

function buildEventData(b: BookingEventInput): Record<string, unknown> {
  const startDt = new Date(`${b.bookingDate}T${b.bookingTime}Z`)
  const endDt = new Date(startDt.getTime() + b.durationMinutes * 60 * 1000)
  const endTimeISO = endDt.toISOString().slice(11, 19)
  const endDateISO = endDt.toISOString().slice(0, 10)

  const title = b.serviceName
    ? `${b.serviceName} — ${b.customerName} (${b.numberOfPeople})`
    : `${b.customerName} (${b.numberOfPeople} guests)`

  const descParts = [`Booked via Caye`, `${b.numberOfPeople} guests`]
  if (b.notes) descParts.push(`\nNotes: ${b.notes}`)

  return {
    title,
    description: descParts.join('\n'),
    dateandtime: {
      start: toZohoDateTime(b.bookingDate, b.bookingTime),
      end: toZohoDateTime(endDateISO, endTimeISO),
      timezone: 'UTC',
    },
  }
}

async function getOrFetchCalendarId(
  workspaceId: string,
  apiDomain: string,
  accessToken: string,
  cachedId?: string
): Promise<string> {
  if (cachedId) return cachedId

  const base = calendarBase(apiDomain)
  const res = await fetch(`${base}/api/v1/calendars`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  })
  const data = await res.json()
  const calendars: Array<{ uid: string; isdefault?: string | boolean; default?: boolean }> =
    Array.isArray(data?.calendars) ? data.calendars : []

  // Find the default calendar (Zoho uses "isdefault" as string 'true' OR boolean)
  const def = calendars.find(c => c.isdefault === true || c.isdefault === 'true' || c.default === true)
  const calId = def?.uid || calendars[0]?.uid
  if (!calId) {
    throw new Error('No Zoho calendar found for this account')
  }

  // Cache it in metadata for next time
  const supabase = createServiceClient()
  await supabase.rpc('jsonb_merge_metadata', { _workspace_id: workspaceId, _key: 'zoho_calendar_id', _value: calId }).then(
    () => {},
    async () => {
      // RPC may not exist — fall back to read-modify-write
      const { data: row } = await supabase
        .from('connected_accounts')
        .select('id, metadata')
        .eq('user_id', workspaceId)
        .eq('channel_type', 'email')
        .eq('is_active', true)
        .maybeSingle()
      if (row) {
        const md = (row.metadata as Record<string, unknown>) || {}
        await supabase
          .from('connected_accounts')
          .update({ metadata: { ...md, zoho_calendar_id: calId } })
          .eq('id', row.id)
      }
    }
  )

  return calId
}

/**
 * Creates an event on the user's Zoho default calendar. Returns the Zoho event UID
 * so the caller can store it on the booking row.
 */
export async function createZohoCalendarEvent(
  workspaceId: string,
  booking: BookingEventInput
): Promise<string> {
  const { accessToken, apiDomain, accountRow } = await getZohoContext(workspaceId)
  const meta = (accountRow.metadata as Record<string, string>) || {}
  const calId = await getOrFetchCalendarId(workspaceId, apiDomain, accessToken, meta.zoho_calendar_id)

  const eventdata = buildEventData(booking)
  const base = calendarBase(apiDomain)
  const formBody = new URLSearchParams({ eventdata: JSON.stringify(eventdata) }).toString()

  const res = await fetch(`${base}/api/v1/calendars/${calId}/events`, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody,
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(`Zoho Calendar create failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`)
  }
  const uid = data?.events?.[0]?.uid || data?.uid
  if (!uid) {
    throw new Error(`Zoho Calendar create returned no event uid: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return String(uid)
}

export async function updateZohoCalendarEvent(
  workspaceId: string,
  eventId: string,
  booking: BookingEventInput
): Promise<void> {
  const { accessToken, apiDomain, accountRow } = await getZohoContext(workspaceId)
  const meta = (accountRow.metadata as Record<string, string>) || {}
  const calId = await getOrFetchCalendarId(workspaceId, apiDomain, accessToken, meta.zoho_calendar_id)

  const eventdata = buildEventData(booking)
  const base = calendarBase(apiDomain)
  const formBody = new URLSearchParams({ eventdata: JSON.stringify(eventdata) }).toString()

  const res = await fetch(`${base}/api/v1/calendars/${calId}/events/${eventId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody,
  })
  if (!res.ok) {
    const data = await res.text()
    throw new Error(`Zoho Calendar update failed (${res.status}): ${data.slice(0, 300)}`)
  }
}

export async function deleteZohoCalendarEvent(
  workspaceId: string,
  eventId: string
): Promise<void> {
  const { accessToken, apiDomain, accountRow } = await getZohoContext(workspaceId)
  const meta = (accountRow.metadata as Record<string, string>) || {}
  const calId = await getOrFetchCalendarId(workspaceId, apiDomain, accessToken, meta.zoho_calendar_id)

  const base = calendarBase(apiDomain)
  const res = await fetch(`${base}/api/v1/calendars/${calId}/events/${eventId}`, {
    method: 'DELETE',
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  })
  // Tolerate 404 — event already gone on Zoho side
  if (!res.ok && res.status !== 404) {
    const data = await res.text()
    throw new Error(`Zoho Calendar delete failed (${res.status}): ${data.slice(0, 300)}`)
  }
}
