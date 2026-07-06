import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { sendTemplateWhatsApp } from '@/lib/whatsapp/outbound'
import { normalizeE164 } from './add-team-member'
import type { Tool } from '../types'

interface NotifyDriverInput {
  guest_name: string
  driver_phone: string
  pickup_location: string
}

/**
 * Dispatch a pickup to a driver (2026-07-05, Karenda's request — grilled
 * same session). Deterministic by design: every field in the WhatsApp
 * template is read straight from the booking row, never recomposed by
 * an LLM — a wrong pickup time/location sent to a driver means a missed
 * tour, not a correction-in-the-next-message like a guest reply.
 *
 * pickup_location is a required input rather than auto-resolved from
 * business_facts — different tours can have different meeting points,
 * and there's no single structured "the pickup location" field. The
 * owner states it in the same message that triggers this tool, and Caye
 * passes it straight through.
 */
export const notifyDriver: Tool<NotifyDriverInput> = {
  name: 'notify_driver',
  description:
    "Send a driver/guide the pickup details for a specific booking — guest name, tour, time, " +
    "guest count, and pickup location. Use when the owner asks you to tell a driver about a " +
    "pickup (e.g. \"tell James about Bridgette's 1pm tour, pickup is the Casino Tram Stop\"). " +
    "The driver must already be added via add_team_member with role driver and verified " +
    "(replied OK) — if they haven't, tell the owner to add them first.",
  risk: 'low',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      guest_name: {
        type: 'string',
        description: "The guest's name on the booking, used to find it (e.g. \"Bridgette Jones\").",
      },
      driver_phone: {
        type: 'string',
        description: "The driver's phone number — any E.164-ish format works.",
      },
      pickup_location: {
        type: 'string',
        description: 'Where the driver should meet the guest, as stated by the owner.',
      },
    },
    required: ['guest_name', 'driver_phone', 'pickup_location'],
  },

  async execute(args, ctx) {
    const phone = normalizeE164(args.driver_phone)
    if (!phone) return { ok: false, error: 'Driver phone number is not valid.' }

    const supabase = createServiceClient()

    const { data: driver } = await supabase
      .from('operator_allowlist')
      .select('id, name, role, verified_at')
      .eq('workspace_id', ctx.workspaceId)
      .eq('phone', phone)
      .maybeSingle()

    if (!driver || driver.role !== 'driver') {
      return {
        ok: false,
        error: `${phone} isn't on the driver list for this workspace. Add them first with add_team_member (role: driver).`,
      }
    }
    if (!driver.verified_at) {
      return {
        ok: false,
        error: `${driver.name ?? phone} hasn't confirmed yet (waiting on their "OK" reply) — dispatch will wait until they do.`,
      }
    }

    const todayISO = new Date().toISOString().slice(0, 10)
    const { data: booking } = await supabase
      .from('bookings')
      .select('id, customer_name, booking_date, booking_time, number_of_people, booking_services(name)')
      .eq('user_id', ctx.workspaceId)
      .ilike('customer_name', `%${args.guest_name.trim()}%`)
      .gte('booking_date', todayISO)
      .order('booking_date', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (!booking) {
      return { ok: false, error: `No upcoming booking found for "${args.guest_name}".` }
    }

    const service = Array.isArray(booking.booking_services)
      ? booking.booking_services[0]
      : booking.booking_services
    const tourName = service?.name ?? 'tour'
    const pickupTime = booking.booking_time ? booking.booking_time.slice(0, 5) : 'TBD'
    const guestCount = booking.number_of_people != null ? String(booking.number_of_people) : 'TBD'

    const sent = await sendTemplateWhatsApp(
      phone,
      'caye_driver_dispatch',
      [driver.name ?? 'there', booking.customer_name ?? args.guest_name, tourName, pickupTime, args.pickup_location.trim(), guestCount],
      `driver-dispatch-${booking.id}-${phone}-${Date.now()}`
    )

    await supabase.from('booking_driver_assignments').upsert(
      {
        workspace_id: ctx.workspaceId,
        booking_id: booking.id,
        driver_phone: phone,
        driver_name: driver.name,
        assigned_at: new Date().toISOString(),
      },
      { onConflict: 'booking_id,driver_phone' }
    )

    if (sent.status !== 'sent') {
      return {
        ok: false,
        error: `Assignment saved, but the WhatsApp send failed: ${sent.error}`,
      }
    }

    return {
      ok: true,
      data: {
        driver: driver.name ?? phone,
        guest: booking.customer_name,
        tour: tourName,
        pickup_time: pickupTime,
        pickup_location: args.pickup_location.trim(),
      },
    }
  },
}
