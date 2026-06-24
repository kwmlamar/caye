import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../types'

interface GetRecentActivityInput {
  hours?: number
}

interface BookingEvent {
  customer_name: string | null
  status: string
  booking_date: string
  created_at: string
  updated_at: string
}

interface ConvEvent {
  id: string
  customer_name: string | null
  channel_type: string
  human_agent_enabled: boolean
  human_agent_marked_at: string | null
  last_message_at: string | null
}

export const getRecentActivity: Tool<GetRecentActivityInput> = {
  name: 'get_recent_activity',
  description:
    "Get a chronological feed of recent activity: new bookings, status changes, holds opened. Defaults to last 24 hours. Use when the operator asks 'what happened?' or 'what's new since I last checked?'.",
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
    const supabase = createServiceClient()
    const hours = Math.min(args.hours ?? 24, 168)
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

    const { data: bookings } = await supabase
      .from('bookings')
      .select('customer_name, status, booking_date, created_at, updated_at')
      .eq('user_id', ctx.workspaceId)
      .or(`created_at.gte.${cutoff},updated_at.gte.${cutoff}`)
      .order('updated_at', { ascending: false })
      .limit(20)

    const { data: accounts } = await supabase
      .from('connected_accounts')
      .select('id')
      .eq('user_id', ctx.workspaceId)
    const accountIds = (accounts ?? []).map((a: { id: string }) => a.id)

    let holds: ConvEvent[] = []
    if (accountIds.length > 0) {
      const { data } = await supabase
        .from('unified_conversations')
        .select(
          'id, customer_name, channel_type, human_agent_enabled, human_agent_marked_at, last_message_at'
        )
        .in('connected_account_id', accountIds)
        .gte('human_agent_marked_at', cutoff)
        .order('human_agent_marked_at', { ascending: false })
        .limit(10)
      holds = (data ?? []) as ConvEvent[]
    }

    const bookingRows = (bookings ?? []) as BookingEvent[]
    return {
      ok: true,
      data: {
        window_hours: hours,
        booking_events: bookingRows.map((b) => ({
          customer: b.customer_name,
          booking_date: b.booking_date,
          status: b.status,
          event: b.created_at === b.updated_at ? 'created' : 'updated',
          at: b.updated_at,
        })),
        hold_events: holds.map((c) => ({
          conversation_id: c.id,
          customer: c.customer_name,
          channel: c.channel_type,
          marked_at: c.human_agent_marked_at,
        })),
      },
    }
  },
}
