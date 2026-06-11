import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface GetRevenueInput {
  period?: 'today' | 'week' | 'month'
}

interface BookingRow {
  status: string
  total_price: number | null
  booking_date: string
}

export const getRevenue: Tool<GetRevenueInput> = {
  name: 'get_revenue',
  description:
    'Get confirmed-booking revenue for a period. Defaults to today. Use when the operator asks about money in the door, this week\'s take, etc.',
  risk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: ['today', 'week', 'month'],
        description: 'Time window. Defaults to "today".',
      },
    },
  },

  async execute(args, ctx) {
    const supabase = createServiceClient()
    const period = args.period ?? 'today'
    const today = new Date()
    const startDate = new Date(today)
    if (period === 'week') startDate.setDate(today.getDate() - 6)
    else if (period === 'month') startDate.setDate(today.getDate() - 29)
    const startISO = startDate.toISOString().slice(0, 10)
    const endISO = today.toISOString().slice(0, 10)

    const { data, error } = await supabase
      .from('bookings')
      .select('status, total_price, booking_date')
      .eq('user_id', ctx.workspaceId)
      .gte('booking_date', startISO)
      .lte('booking_date', endISO)

    if (error) return { ok: false, error: error.message }
    const rows = (data ?? []) as BookingRow[]
    const confirmed = rows.filter((r) => r.status === 'confirmed')
    const pending = rows.filter((r) => r.status !== 'confirmed' && r.status !== 'cancelled')
    const confirmedRevenue = confirmed.reduce((s, r) => s + (r.total_price ?? 0), 0)
    const pendingRevenue = pending.reduce((s, r) => s + (r.total_price ?? 0), 0)

    return {
      ok: true,
      data: {
        period,
        from: startISO,
        to: endISO,
        confirmed_revenue: confirmedRevenue,
        confirmed_bookings: confirmed.length,
        pending_revenue: pendingRevenue,
        pending_bookings: pending.length,
      },
    }
  },
}
