import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getAttentionHoldCount } from '@/lib/hold-kinds'
import type { Tool } from '../types'
import {
  bookingRevenue,
  BOOKING_WITH_SERVICE_PRICE_SELECT,
  type ServiceJoin,
} from '../_revenue'
import { businessLocalDate } from '@/lib/booking-time'

const DEFAULT_WORKSPACE_TIMEZONE = 'America/Nassau'

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
    // Business-local calendar date (CAY-91) — NOT the server's UTC date.
    // "Today" for the workspace's owner means today in the workspace's own
    // timezone; a UTC-only date can be a full calendar day off depending on
    // the workspace and time of day.
    const today = businessLocalDate(ctx.workspaceTimezone || DEFAULT_WORKSPACE_TIMEZONE)

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

    const heldCount = await getAttentionHoldCount(supabase, ctx.workspaceId)

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
