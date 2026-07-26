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

interface FollowUpMsg {
  conversation_id: string
  sent_at: string
  metadata: Record<string, unknown> | null
}

type Resolution = 'replied' | 'replied_then_corrected' | 'answered_by_operator' | 'resolved_no_reply'

/**
 * What actually happened after a hold was cleared, from the business
 * messages sent on that conversation since it was marked held. Distinct
 * outcomes matter here — "replied" (Caye answered it herself) reads very
 * differently from "replied_then_corrected" (Caye answered, then the owner
 * sent a different reply on the same thread — worth surfacing if asked),
 * which reads differently again from "answered_by_operator" (a human
 * replied directly, Caye never touched it).
 */
function classifyResolution(markedAt: string | null, msgs: FollowUpMsg[]): Resolution {
  const after = msgs.filter((m) => !markedAt || m.sent_at > markedAt)
  if (after.length === 0) return 'resolved_no_reply'
  const hasCorrection = after.some((m) => (m.metadata as Record<string, unknown> | null)?.is_correction === true)
  if (hasCorrection) return 'replied_then_corrected'
  const cayeReplied = after.some((m) => (m.metadata as Record<string, unknown> | null)?.generated_by === 'caye')
  return cayeReplied ? 'replied' : 'answered_by_operator'
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

    // For every hold that's since been cleared, figure out what actually
    // happened — one batched query across all of them rather than N
    // per-conversation round-trips. is_internal=false excludes the hold
    // note Caye writes to herself when opening the hold; sent_at filtering
    // to strictly after each conversation's own marked_at happens below,
    // per-conversation, since this single query can only apply one lower
    // bound (the earliest across all of them).
    const resolvedConvIds = holds.filter((c) => !c.human_agent_enabled).map((c) => c.id)
    const followUpsByConv = new Map<string, FollowUpMsg[]>()
    if (resolvedConvIds.length > 0) {
      const earliestMarkedAt = holds.reduce<string>((min, c) => {
        if (!c.human_agent_marked_at) return min
        return !min || c.human_agent_marked_at < min ? c.human_agent_marked_at : min
      }, '')
      const { data: followUps } = await supabase
        .from('unified_messages')
        .select('conversation_id, sent_at, metadata')
        .in('conversation_id', resolvedConvIds)
        .eq('sender_type', 'business')
        .eq('is_internal', false)
        .gte('sent_at', earliestMarkedAt || cutoff)
        .order('sent_at', { ascending: true })
        .limit(100)

      for (const m of (followUps ?? []) as FollowUpMsg[]) {
        const list = followUpsByConv.get(m.conversation_id) ?? []
        list.push(m)
        followUpsByConv.set(m.conversation_id, list)
      }
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
          still_held: c.human_agent_enabled,
          resolution: c.human_agent_enabled
            ? null
            : classifyResolution(c.human_agent_marked_at, followUpsByConv.get(c.id) ?? []),
        })),
      },
    }
  },
}
