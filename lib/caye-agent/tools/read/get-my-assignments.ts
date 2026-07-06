import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface GetMyAssignmentsInput {
  /** noop — kept so the tool always has a valid (empty) input schema */
}

interface AssignmentRow {
  booking_id: string
  driver_reminder_sent_at: string | null
  bookings: {
    customer_name: string | null
    booking_date: string
    booking_time: string | null
    number_of_people: number | null
    booking_services: { name: string | null } | { name: string | null }[] | null
  } | null
}

/**
 * Driver-mode tool (2026-07-05): "what am I picking up?" Scoped entirely
 * to the caller's own phone via booking_driver_assignments — a driver can
 * never see another driver's assignments. Only upcoming (today-or-later)
 * bookings are returned; past assignments are irrelevant to "what's my
 * pickup."
 */
export const getMyAssignments: Tool<GetMyAssignmentsInput> = {
  name: 'get_my_assignments',
  description:
    'Look up the tour pickup(s) currently assigned to you. Use this whenever the driver asks ' +
    'about their pickup time, location, guest count, or which tour they\'re on.',
  risk: 'read',
  roles: ['driver'],
  modes: ['driver'],
  inputSchema: { type: 'object', properties: {} },

  async execute(_args, ctx) {
    if (!ctx.callerPhone) return { ok: false, error: 'No caller phone on this request.' }

    const supabase = createServiceClient()
    const todayISO = new Date().toISOString().slice(0, 10)

    const { data, error } = await supabase
      .from('booking_driver_assignments')
      .select(
        `booking_id, driver_reminder_sent_at,
         bookings!inner(customer_name, booking_date, booking_time, number_of_people, booking_services(name))`
      )
      .eq('workspace_id', ctx.workspaceId)
      .eq('driver_phone', ctx.callerPhone)
      .gte('bookings.booking_date', todayISO)
      .order('bookings(booking_date)', { ascending: true })
      .limit(10)

    if (error) return { ok: false, error: error.message }

    const rows = (data ?? []) as unknown as AssignmentRow[]
    if (rows.length === 0) {
      return { ok: true, data: { assignments: [] } }
    }

    return {
      ok: true,
      data: {
        assignments: rows.map((r) => {
          const svc = Array.isArray(r.bookings?.booking_services)
            ? r.bookings?.booking_services[0]
            : r.bookings?.booking_services
          return {
            guest_name: r.bookings?.customer_name ?? null,
            tour_name: svc?.name ?? null,
            pickup_date: r.bookings?.booking_date ?? null,
            pickup_time: r.bookings?.booking_time ?? null,
            guest_count: r.bookings?.number_of_people ?? null,
          }
        }),
      },
    }
  },
}
