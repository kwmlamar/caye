import 'server-only'
import { getActivitySince } from '../../activity-since'
import type { Tool } from '../types'

interface GetRecentActivityInput {
  hours?: number
}

export const getRecentActivity: Tool<GetRecentActivityInput> = {
  name: 'get_recent_activity',
  description:
    "Get a chronological feed of recent activity: new bookings, status changes, holds opened. Defaults to last 24 hours. Use when the operator asks 'what happened?' or 'what's new since I last checked?'. " +
    "Each hold_event carries still_held — true means it's genuinely awaiting the operator's call RIGHT NOW; false means it's already been dealt with. NEVER describe a still_held=false item as pending or awaiting attention — that's exactly the kind of stale reporting that erodes trust (confirmed live 2026-07-26: Caye told the owner a thread was 'held' hours after it had already been auto-replied to and then corrected). When still_held=false, use `resolution` to say what actually happened: 'replied' = Caye answered it herself, 'replied_then_corrected' = Caye answered and the owner later sent a different reply on the same thread (worth naming if asked why), 'answered_by_operator' = a human replied directly and Caye never touched it, 'resolved_no_reply' = cleared with no reply sent (e.g. the owner marked it handled).",
  risk: 'read',
  roles: ['owner', 'founder'],
  modes: ['back-office'],
  inputSchema: {
    type: 'object',
    properties: {
      hours: {
        type: 'number',
        description: 'Window in hours. Defaults to 24. Max 168 (one week).',
      },
    },
  },

  async execute(args, ctx) {
    const hours = Math.min(args.hours ?? 24, 168)
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

    const activity = await getActivitySince(ctx.workspaceId, cutoff, { limit: 20 })

    return {
      ok: true,
      data: {
        window_hours: hours,
        booking_events: activity.bookingEvents.map((b) => ({
          customer: b.customer,
          booking_date: b.bookingDate,
          status: b.status,
          event: b.event,
          at: b.at,
        })),
        hold_events: activity.holdEvents.map((h) => ({
          conversation_id: h.conversationId,
          customer: h.customer,
          channel: h.channel,
          marked_at: h.markedAt,
          still_held: h.stillHeld,
          resolution: h.resolution,
        })),
      },
    }
  },
}
