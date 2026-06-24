import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import {
  bookingRevenue,
  BOOKING_WITH_SERVICE_PRICE_SELECT,
  type ServiceJoin,
} from '../_revenue'

interface GetRecentBookingsInput {
  days?: number
}

interface BookingRow {
  customer_name: string | null
  booking_date: string
  booking_time: string | null
  number_of_people: number | null
  status: string
  created_at: string
  service: ServiceJoin[] | null
}

export const getRecentBookings: Tool<GetRecentBookingsInput> = {
  name: 'get_recent_bookings',
  description:
    'List bookings created in the last N days (default 7). Use when the operator asks about the latest bookings or wants a quick scan of recent activity.',
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      days: {
        type: 'number',
        description: 'How many days back to look. Defaults to 7. Max 90.',
      },
    },
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()
    const days = Math.min(args.days ?? 7, 90)
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    const { data, error } = await supabase
      .from('bookings')
      .select(
        `customer_name, booking_date, booking_time, number_of_people, status, created_at, ${BOOKING_WITH_SERVICE_PRICE_SELECT}`
      )
      .eq('user_id', ctx.workspaceId)
      .gte('created_at', cutoff)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: false })
      .limit(25)

    if (error) return { ok: false, error: error.message }
    const rows = (data ?? []) as unknown as BookingRow[]
    return {
      ok: true,
      data: {
        days,
        bookings: rows.map((r) => ({
          customer: r.customer_name,
          date: r.booking_date,
          time: r.booking_time?.slice(0, 5) ?? null,
          guests: r.number_of_people,
          price: bookingRevenue({
            servicePrice: r.service?.[0]?.price,
            priceType: r.service?.[0]?.price_type,
            guests: r.number_of_people,
          }),
          status: r.status,
          service: r.service?.[0]?.name ?? null,
          created_at: r.created_at,
        })),
        count: rows.length,
      },
    }
  },
}
