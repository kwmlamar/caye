import 'server-only'
import { fetchBookingsInRange, type BookingLite } from '@/lib/calendar-availability'
import type { Tool } from '../types'

interface GetCalendarInput {
  date?: string
  end_date?: string
}

type BookingRow = BookingLite

export const getCalendar: Tool<GetCalendarInput> = {
  name: 'get_calendar',
  description:
    "Get confirmed and pending bookings for a date or date range. Use when the operator asks about today's schedule, what's booked tomorrow, who's coming next week, etc. Cancelled bookings are excluded.",
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description:
          "ISO date (YYYY-MM-DD). Defaults to today if omitted. For 'today', omit this.",
      },
      end_date: {
        type: 'string',
        description:
          'Optional ISO end date (YYYY-MM-DD) for a range. Inclusive. Omit for a single day.',
      },
    },
  },

  async execute(args, ctx) {
    const today = new Date().toISOString().slice(0, 10)
    const start = args.date ?? today
    const end = args.end_date ?? start

    const result = await fetchBookingsInRange(ctx.workspaceId, start, end)
    if (!result.ok) return { ok: false, error: result.error }

    const rows = result.bookings as unknown as BookingRow[]
    return {
      ok: true,
      data: {
        date_range: start === end ? start : { from: start, to: end },
        bookings: rows.map((r) => ({
          customer: r.customer_name,
          date: r.booking_date,
          time: r.booking_time?.slice(0, 5) ?? null,
          guests: r.number_of_people,
          service: r.service?.[0]?.name ?? null,
          status: r.status,
        })),
        count: rows.length,
      },
    }
  },
}
