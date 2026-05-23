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
  const calendars: Array<{ uid: string; isdefault?: string | boolean; default?: boolean; name?: string }> =
    Array.isArray(data?.calendars) ? data.calendars : []

  console.log(
    `[zoho-calendar] getOrFetchCalendarId workspace=${workspaceId} found ${calendars.length} calendars: ` +
      calendars.map(c => `${c.name ?? '?'}[${c.uid}${c.isdefault ? ' default' : ''}]`).join(', ')
  )

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

/**
 * Normalized event shape used by the inbound poller.
 * Dates/times are returned in plain ISO so the caller can write straight to bookings.
 */
export interface ZohoEventSummary {
  uid: string
  title: string
  description: string | null
  isAllDay: boolean
  startDate: string   // 'YYYY-MM-DD'
  startTime: string   // 'HH:MM:SS' (UTC)
  durationMinutes: number
}

function parseZohoDateTime(s: string): Date | null {
  if (!s) return null
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(s)
  if (compact) {
    const [, y, mo, d, h, mi, se] = compact
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}Z`)
  }
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t) : null
}

interface ZohoRawEvent {
  uid?: string
  title?: string
  description?: string
  isallday?: boolean | string
  dateandtime?: { start?: string; end?: string; timezone?: string }
}

// Zoho caps a single events list request at 31 days. We chunk larger ranges.
const ZOHO_MAX_RANGE_DAYS = 30

function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function fetchEventsChunk(
  apiDomain: string,
  calId: string,
  accessToken: string,
  fromDateISO: string,
  toDateISO: string
): Promise<ZohoRawEvent[]> {
  const startCompact = `${fromDateISO.replace(/-/g, '')}T000000Z`
  const endCompact = `${toDateISO.replace(/-/g, '')}T235959Z`
  const range = encodeURIComponent(JSON.stringify({ start: startCompact, end: endCompact }))

  const base = calendarBase(apiDomain)
  const url = `${base}/api/v1/calendars/${calId}/events?range=${range}`
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `Zoho Calendar list failed (${res.status}) for ${fromDateISO}..${toDateISO}: ${text.slice(0, 300)}`
    )
  }

  const data = await res.json()
  const events: ZohoRawEvent[] = Array.isArray(data?.events) ? data.events : []
  console.log(
    `[zoho-calendar] list ${fromDateISO}..${toDateISO} cal=${calId} → ${events.length} events. ` +
      `Sample keys: ${Object.keys(data || {}).join(',')}. ` +
      `First event: ${events[0] ? JSON.stringify(events[0]).slice(0, 300) : '(none)'}`
  )
  return events
}

/**
 * Lists events on the workspace's default Zoho calendar between the given
 * dates (inclusive). Returns normalized summaries — events without parseable
 * start/end are skipped.
 *
 * Zoho's API caps a single list call at 31 days, so we chunk the window into
 * 30-day slices and merge the results (deduped by uid in case of overlap).
 */
export async function listZohoCalendarEvents(
  workspaceId: string,
  fromDateISO: string,
  toDateISO: string
): Promise<ZohoEventSummary[]> {
  const { accessToken, apiDomain, accountRow } = await getZohoContext(workspaceId)
  const meta = (accountRow.metadata as Record<string, string>) || {}
  const calId = await getOrFetchCalendarId(workspaceId, apiDomain, accessToken, meta.zoho_calendar_id)

  // Build chunked ranges
  const raw: ZohoRawEvent[] = []
  let chunkStart = fromDateISO
  while (chunkStart <= toDateISO) {
    const tentativeEnd = addDaysISO(chunkStart, ZOHO_MAX_RANGE_DAYS - 1)
    const chunkEnd = tentativeEnd > toDateISO ? toDateISO : tentativeEnd
    const events = await fetchEventsChunk(apiDomain, calId, accessToken, chunkStart, chunkEnd)
    raw.push(...events)
    chunkStart = addDaysISO(chunkEnd, 1)
  }

  // Dedupe by uid and normalize
  const seen = new Set<string>()
  const out: ZohoEventSummary[] = []
  for (const ev of raw) {
    const uid = ev.uid
    const dt = ev.dateandtime
    if (!uid || !dt?.start || !dt?.end) continue
    if (seen.has(uid)) continue
    seen.add(uid)

    const start = parseZohoDateTime(dt.start)
    const end = parseZohoDateTime(dt.end)
    if (!start || !end) continue

    const isAllDay = ev.isallday === true || ev.isallday === 'true'
    const durationMinutes = Math.max(15, Math.round((end.getTime() - start.getTime()) / 60000))
    const iso = start.toISOString()

    out.push({
      uid,
      title: (ev.title ?? '').trim() || 'Untitled event',
      description: ev.description ?? null,
      isAllDay,
      startDate: iso.slice(0, 10),
      startTime: iso.slice(11, 19),
      durationMinutes,
    })
  }

  return out
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
