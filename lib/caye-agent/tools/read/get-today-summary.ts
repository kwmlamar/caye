import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'
import {
  bookingRevenue,
  BOOKING_WITH_SERVICE_PRICE_SELECT,
  type ServiceJoin,
} from '../_revenue'

interface BookingRow {
  status: string
  number_of_people: number | null
  service: ServiceJoin[] | null
}

export const getTodaySummary: Tool<Record<string, never>> = {
  name: 'get_today_summary',
  description:
    "Get a high-level summary of today: confirmed bookings count, pending bookings count, confirmed revenue, and held items count. Use when the operator asks 'how's today looking?' or wants a quick read of where things stand.",
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {},
  },

  async execute(_args, ctx) {
    const supabase = createServiceClient()
    const today = new Date().toISOString().slice(0, 10)

    const { data: bookings, error: bookingsErr } = await supabase
      .from('bookings')
      .select(`status, number_of_people, ${BOOKING_WITH_SERVICE_PRICE_SELECT}`)
      .eq('user_id', ctx.workspaceId)
      .eq('booking_date', today)
      .neq('status', 'cancelled')

    if (bookingsErr) return { ok: false, error: bookingsErr.message }

    const bookingRows = (bookings ?? []) as unknown as BookingRow[]
    const confirmedCount = bookingRows.filter((b) => b.status === 'confirmed').length
    const pendingCount = bookingRows.filter((b) => b.status !== 'confirmed').length
    const revenueConfirmed = bookingRows
      .filter((b) => b.status === 'confirmed')
      .reduce(
        (sum, b) =>
          sum +
          bookingRevenue({
            servicePrice: b.service?.[0]?.price,
            priceType: b.service?.[0]?.price_type,
            guests: b.number_of_people,
          }),
        0
      )

    // Held items count — re-query rather than join to keep the query simple.
    let heldCount = 0
    const { data: accounts } = await supabase
      .from('connected_accounts')
      .select('id')
      .eq('user_id', ctx.workspaceId)
    const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)
    if (accountIds.length > 0) {
      const { count } = await supabase
        .from('unified_conversations')
        .select('id', { count: 'exact', head: true })
        .in('connected_account_id', accountIds)
        .eq('is_archived', false)
        .eq('human_agent_enabled', true)
      heldCount = count ?? 0
    }

    return {
      ok: true,
      data: {
        date: today,
        bookings: { confirmed: confirmedCount, pending: pendingCount },
        revenue_confirmed: revenueConfirmed,
        held_items: heldCount,
        // TODO(#40): replies_sent — requires join through unified_conversations
        // to filter by workspace. Deferred to read-tools-batch-B since that
        // slice adds the activity-feed plumbing anyway.
      },
    }
  },
}
