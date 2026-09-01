/**
 * Job-search response loop — create a personal calendar event on the
 * founder's OWN Zoho calendar for a scheduled interview/screen, once the
 * founder has confirmed a concrete date/time in conversation.
 *
 * Scope is deliberately narrow: this writes a PERSONAL reminder event only
 * — no attendees, no invite email sent to the recruiter. Adding an
 * attendee would make this a consequential external side effect (Zoho
 * emails the invite on our behalf); that's out of scope here and, if
 * wanted later, belongs behind the same reply-sending authority as
 * lib/job-search/founder-mail.ts, not bundled into calendar-write.
 *
 * Deliberately does not reuse lib/zoho-calendar.ts: every export there is
 * workspace-scoped (`getZohoContext(workspaceId)` against
 * `connected_accounts`), and the founder's job-search Zoho grant is
 * intentionally isolated from that table (see
 * supabase/migrations/20260829c_founder_job_search_email.sql's isolation
 * note). The founder's Zoho OAuth token already carries
 * ZohoCalendar.event.ALL + ZohoCalendar.calendar.READ (see
 * app/api/auth/zoho/route.ts's SCOPES) even though nothing previously used
 * it — this module is the first caller.
 */
import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { getFreshFounderZohoAccount, type FounderZohoAccount } from './founder-zoho'

function calendarBase(apiDomain: string): string {
  return (apiDomain || 'https://www.zohoapis.com').replace('www.zohoapis', 'calendar.zoho')
}

function toZohoUTCCompact(d: Date): string {
  const iso = d.toISOString()
  return (
    iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) +
    'T' + iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19) + 'Z'
  )
}

async function getActiveFounderAccount(): Promise<FounderZohoAccount> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('founder_connected_accounts')
    .select('*')
    .eq('provider', 'zoho')
    .eq('is_active', true)
    .eq('needs_reauth', false)
    .limit(1)
    .maybeSingle()
  if (error || !data) throw new Error('No active founder Zoho account connected for job-search calendar events')
  return data as FounderZohoAccount
}

async function getOrFetchCalendarId(base: string, accessToken: string, cachedId?: string): Promise<string> {
  if (cachedId) return cachedId
  const res = await fetch(`${base}/api/v1/calendars`, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } })
  const data = await res.json() as { calendars?: Array<{ uid: string; isdefault?: string | boolean; default?: boolean }> }
  const calendars = Array.isArray(data.calendars) ? data.calendars : []
  const def = calendars.find((c) => c.isdefault === true || c.isdefault === 'true' || c.default === true)
  const calId = def?.uid || calendars[0]?.uid
  if (!calId) throw new Error('No Zoho calendar found for the founder account')
  return calId
}

export type CreateFounderInterviewEventInput = {
  applicationId: string
  title: string
  /** ISO instant, e.g. from Date.toISOString(). */
  startAt: string
  durationMinutes: number
  notes?: string | null
}

/** Creates a personal (no-attendee) calendar event for an interview/screen. Not itself external-contact — safe to run without founder-confirmation gating beyond having a concrete time in hand. */
export async function createFounderInterviewEvent(input: CreateFounderInterviewEventInput): Promise<string> {
  const raw = await getActiveFounderAccount()
  const account = await getFreshFounderZohoAccount(raw)
  const base = calendarBase(account.metadata.zoho_api_domain)
  const calId = await getOrFetchCalendarId(base, account.access_token, account.metadata.zoho_calendar_id)

  const start = new Date(input.startAt)
  const end = new Date(start.getTime() + input.durationMinutes * 60_000)

  const eventdata = {
    title: input.title,
    description: [input.notes, `job_search_application_id: ${input.applicationId}`].filter(Boolean).join('\n\n'),
    dateandtime: {
      start: toZohoUTCCompact(start),
      end: toZohoUTCCompact(end),
      timezone: 'UTC',
    },
  }

  const res = await fetch(`${base}/api/v1/calendars/${calId}/events`, {
    method: 'POST',
    headers: {
      Authorization: `Zoho-oauthtoken ${account.access_token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ eventdata: JSON.stringify(eventdata) }).toString(),
  })
  const data = await res.json() as { events?: Array<{ uid?: string }>; uid?: string }
  if (!res.ok) throw new Error(`Zoho Calendar create failed for founder interview event (${res.status}): ${JSON.stringify(data).slice(0, 300)}`)
  const uid = data.events?.[0]?.uid || data.uid
  if (!uid) throw new Error(`Zoho Calendar create returned no event uid: ${JSON.stringify(data).slice(0, 200)}`)
  return String(uid)
}
