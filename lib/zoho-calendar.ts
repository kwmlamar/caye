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
 * Convert a (date, time, IANA tz) tuple — interpreted as wall-clock time in
 * that timezone — into the equivalent UTC Date. Uses Intl to read the offset
 * for the specific date so DST is handled correctly.
 */
function localToUTC(dateISO: string, timeISO: string, tz: string): Date {
  // Anchor: pretend the local time IS UTC. Its wall-clock in tz tells us
  // the offset for that moment.
  const anchor = new Date(`${dateISO}T${timeISO.slice(0, 8)}Z`)
  if (!tz || tz === 'UTC') return anchor

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts: Record<string, string> = {}
  for (const p of dtf.formatToParts(anchor)) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  const wallAsUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute), Number(parts.second)
  )
  const offsetMin = (wallAsUTC - anchor.getTime()) / 60000  // tz - UTC, e.g. -300 for CDT
  return new Date(anchor.getTime() - offsetMin * 60000)
}

function toZohoUTCCompact(d: Date): string {
  const iso = d.toISOString()  // 2026-05-24T19:00:00.000Z
  return (
    iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) +
    'T' + iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19) + 'Z'
  )
}

function buildEventData(b: BookingEventInput, tz: string): Record<string, unknown> {
  // booking_date/booking_time are local wall-clock in the workspace's tz.
  const startUTC = localToUTC(b.bookingDate, b.bookingTime, tz)
  const endUTC = new Date(startUTC.getTime() + b.durationMinutes * 60 * 1000)

  const title = b.serviceName
    ? `${b.serviceName} — ${b.customerName} (${b.numberOfPeople})`
    : `${b.customerName} (${b.numberOfPeople} guests)`

  const descParts = [`Booked via Caye`, `${b.numberOfPeople} guests`]
  if (b.notes) descParts.push(`\nNotes: ${b.notes}`)

  return {
    title,
    description: descParts.join('\n'),
    dateandtime: {
      start: toZohoUTCCompact(startUTC),
      end: toZohoUTCCompact(endUTC),
      timezone: tz || 'UTC',
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
  const tz = meta.zoho_user_timezone || 'UTC'

  const eventdata = buildEventData(booking, tz)
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
  const tz = meta.zoho_user_timezone || 'UTC'

  const eventdata = buildEventData(booking, tz)
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
  startDate: string   // 'YYYY-MM-DD' (local wall-clock in the workspace's tz)
  startTime: string   // 'HH:MM:SS'  (local wall-clock in the workspace's tz)
  durationMinutes: number
}

/**
 * Zoho's list response uses 'YYYYMMDDTHHMMSS±HHMM' (with timezone offset)
 * while the create/update payload uses 'YYYYMMDDTHHMMSSZ' (UTC). Both forms
 * need to round-trip cleanly.
 */
function parseZohoDateTime(s: string): Date | null {
  if (!s) return null
  // 20260524T090000-0500  or  20260524T090000Z  or  20260524T090000
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{2}:?\d{2})?$/.exec(s)
  if (m) {
    const [, y, mo, d, h, mi, se, tz] = m
    let zone = 'Z'
    if (tz && tz !== 'Z') {
      // Normalize '-0500' → '-05:00' (Date constructor requires the colon)
      zone = tz.length === 5 ? `${tz.slice(0, 3)}:${tz.slice(3)}` : tz
    }
    const d2 = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${zone}`)
    return Number.isFinite(d2.getTime()) ? d2 : null
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
  user_timezone?: string
}

/**
 * Extracts the wall-clock date and time from a Zoho timestamp string,
 * ignoring the timezone offset. This is what we store in bookings:
 * '20260524T140000-0500' → { date: '2026-05-24', time: '14:00:00' }.
 *
 * The wall-clock IS the booking time the owner sees — when an event is
 * "8am Chicago" the booking row should say 08:00:00, not the UTC equivalent.
 */
function extractLocalParts(s: string): { date: string; time: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(s)
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}:${se}` }
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
  if (events.length > 0 && events[0] && Object.keys(events[0]).length > 1) {
    console.log(
      `[zoho-calendar] list ${fromDateISO}..${toDateISO} cal=${calId} → ${events.length} events. ` +
        `First event keys: [${Object.keys(events[0]).join(',')}]. ` +
        `Full first event: ${JSON.stringify(events[0])}`
    )
  } else {
    console.log(`[zoho-calendar] list ${fromDateISO}..${toDateISO} → 0 events`)
  }
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

  // Discover and cache the workspace's timezone from the first real event.
  // Zoho returns user_timezone on every event; we use it for outbound too.
  const discoveredTz = raw.find(e => e.user_timezone)?.user_timezone
  if (discoveredTz && discoveredTz !== meta.zoho_user_timezone) {
    const supabase = createServiceClient()
    await supabase
      .from('connected_accounts')
      .update({ metadata: { ...meta, zoho_user_timezone: discoveredTz } })
      .eq('id', accountRow.id)
    console.log(`[zoho-calendar] cached zoho_user_timezone=${discoveredTz} for workspace ${workspaceId}`)
  }

  // Dedupe by uid and normalize using LOCAL components (not UTC) so the
  // wall-clock the owner sees in Zoho matches what we store in bookings.
  const seen = new Set<string>()
  const out: ZohoEventSummary[] = []
  for (const ev of raw) {
    const uid = ev.uid
    const dt = ev.dateandtime
    if (!uid || !dt?.start || !dt?.end) continue
    if (seen.has(uid)) continue
    seen.add(uid)

    const localStart = extractLocalParts(dt.start)
    if (!localStart) continue

    // Duration is tz-invariant — compute from the parsed UTC moments.
    const startUtc = parseZohoDateTime(dt.start)
    const endUtc = parseZohoDateTime(dt.end)
    const durationMinutes =
      startUtc && endUtc
        ? Math.max(15, Math.round((endUtc.getTime() - startUtc.getTime()) / 60000))
        : 60

    const isAllDay = ev.isallday === true || ev.isallday === 'true'

    out.push({
      uid,
      title: (ev.title ?? '').trim() || 'Untitled event',
      description: ev.description ?? null,
      isAllDay,
      startDate: localStart.date,
      startTime: localStart.time,
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
