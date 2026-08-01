import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import {
  bookingRevenue,
  BOOKING_WITH_SERVICE_PRICE_SELECT,
  type ServiceJoin,
} from '../_revenue'

interface GetTourTypePerformanceInput {
  period?: 'month' | 'quarter'
}

interface BookingRow {
  status: string
  booking_date: string
  customer_email: string | null
  number_of_people: number | null
  service: ServiceJoin[] | null
}

interface TourStat {
  service_name: string
  confirmed_bookings: number
  confirmed_revenue: number
  average_booking_value: number
}

/**
 * Business-insights building block (2026-07-28) — booking volume/revenue
 * broken out by tour type over a trailing window, plus a simple repeat-
 * customer count. get_revenue only totals a period; this exists because
 * "which tours are performing better/worse" needs the per-service split.
 *
 * Deliberately does NOT attempt response-time-by-channel or an inquiry-to-
 * booking conversion funnel — neither is tracked in the schema today
 * (no per-channel first-response timestamp, no inquiry-stage concept
 * distinct from a created booking row). Don't invent numbers the data
 * can't support.
 */
export const getTourTypePerformance: Tool<GetTourTypePerformanceInput> = {
  name: 'get_tour_type_performance',
  description:
    'Get confirmed-booking volume and revenue broken out by tour/service type over a trailing window, plus a repeat-customer count. Use for business-insights style questions like "which tours are doing best" — get_revenue only gives period totals, not per-tour detail.',
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: ['month', 'quarter'],
        description: 'Trailing window. Defaults to "month" (last 30 days).',
      },
    },
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()
    const period = args.period ?? 'month'
    const today = new Date()
    const startDate = new Date(today)
    startDate.setDate(today.getDate() - (period === 'quarter' ? 89 : 29))
    const startISO = startDate.toISOString().slice(0, 10)
    const endISO = today.toISOString().slice(0, 10)

    const { data, error } = await supabase
      .from('bookings')
      .select(`status, booking_date, customer_email, number_of_people, ${BOOKING_WITH_SERVICE_PRICE_SELECT}`)
      .eq('user_id', ctx.workspaceId)
      .eq('status', 'confirmed')
      .gte('booking_date', startISO)
      .lte('booking_date', endISO)

    if (error) return { ok: false, error: error.message }
    const rows = (data ?? []) as unknown as BookingRow[]

    const byService = new Map<string, TourStat>()
    const emailCounts = new Map<string, number>()

    for (const row of rows) {
      const name = row.service?.[0]?.name ?? 'Unknown'
      const revenue = bookingRevenue({
        servicePrice: row.service?.[0]?.price,
        priceType: row.service?.[0]?.price_type,
        guests: row.number_of_people,
      })
      const stat = byService.get(name) ?? {
        service_name: name,
        confirmed_bookings: 0,
        confirmed_revenue: 0,
        average_booking_value: 0,
      }
      stat.confirmed_bookings += 1
      stat.confirmed_revenue += revenue
      byService.set(name, stat)

      if (row.customer_email) {
        emailCounts.set(row.customer_email, (emailCounts.get(row.customer_email) ?? 0) + 1)
      }
    }

    const tours = Array.from(byService.values())
      .map((s) => ({ ...s, average_booking_value: s.confirmed_bookings ? s.confirmed_revenue / s.confirmed_bookings : 0 }))
      .sort((a, b) => b.confirmed_revenue - a.confirmed_revenue)

    const repeatCustomers = Array.from(emailCounts.values()).filter((n) => n > 1).length

    return {
      ok: true,
      data: {
        period,
        from: startISO,
        to: endISO,
        tours,
        total_confirmed_bookings: rows.length,
        repeat_customers: repeatCustomers,
        note:
          'Only booking volume/revenue/repeat-customer data is available — no per-channel response time or inquiry-to-booking funnel tracking exists yet.',
      },
    }
  },
}
