import 'server-only'
import { listZohoCalendarEvents } from '@/lib/zoho-calendar'
import { businessLocalDate } from '@/lib/booking-time'
import type { Tool } from '../types'

const DEFAULT_WORKSPACE_TIMEZONE = 'America/Nassau'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

interface GetZohoCalendarInput {
  date?: string
  end_date?: string
}

/**
 * Read the connected owner's live Zoho Calendar directly. This complements
 * get_calendar (Caye's local booking source of truth) for questions about
 * manually-created Zoho events or a just-updated external calendar.
 */
export const getZohoCalendar: Tool<GetZohoCalendarInput> = {
  name: 'get_zoho_calendar',
  description:
    "Read the connected owner's live Zoho Calendar directly. Use when they specifically ask what is in Zoho, ask about a manually-created calendar event, or need a fresh external-calendar check that may not yet be in Caye's booking records. For Caye-created bookings, get_calendar remains the normal source of truth.",
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today in the business timezone.' },
      end_date: { type: 'string', description: 'Optional inclusive YYYY-MM-DD end date.' },
    },
  },

  async execute(args, ctx) {
    const today = businessLocalDate(ctx.workspaceTimezone || DEFAULT_WORKSPACE_TIMEZONE)
    const start = args.date ?? today
    const end = args.end_date ?? start
    if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) {
      return { ok: false, status: 'FAILED_PERMANENT', error: 'date and end_date must be YYYY-MM-DD.' }
    }
    if (end < start) {
      return { ok: false, status: 'FAILED_PERMANENT', error: 'end_date cannot be before date.' }
    }

    const events = await listZohoCalendarEvents(ctx.workspaceId, start, end)
    return {
      ok: true,
      data: {
        date_range: start === end ? start : { from: start, to: end },
        events: events.map((event) => ({
          id: event.uid,
          title: event.title,
          date: event.startDate,
          time: event.startTime,
          duration_minutes: event.durationMinutes,
          all_day: event.isAllDay,
          description: event.description,
        })),
        count: events.length,
      },
    }
  },
}
