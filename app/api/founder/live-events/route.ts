/**
 * GET /api/founder/live-events?workspaceId=<uuid>
 *
 * Recent real activity for one workspace, read from workspace_events (the
 * canonical event stream — see supabase/migrations/20260807d_workspace_events.sql).
 * Backs FounderHome's "live pulse" strip: a handful of genuinely recent
 * things that happened, not a synthetic activity feed.
 *
 * Deliberately NOT reusing getWorkspaceFeed's isReportable filter — that
 * policy exists to keep the WhatsApp digest from interrupting founders with
 * routine successes (see lib/caye-agent/workspace-feed.ts). A glanceable
 * dashboard widget wants the opposite bias: booking confirmed and escalation
 * resolved are exactly the "alive" signal worth showing here, even though
 * they're intentionally silent in the digest.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS (same as command-overview).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'
import { isBounceAddress } from '@/lib/caye-agent/workspace-feed'

const EVENT_TYPES = [
  'message.inbound',
  'booking.created',
  'escalation.opened',
  'escalation.resolved',
  'channel.disconnected',
  'channel.reconnected',
] as const

type Tone = 'positive' | 'neutral' | 'alert'

interface RawEvent {
  id: number
  occurred_at: string
  type: string
  conversation_id: string | null
  payload: Record<string, unknown> | null
}

function labelFor(type: string, payload: Record<string, unknown>, customer: string | null): { label: string; tone: Tone } {
  switch (type) {
    case 'message.inbound':
      return { label: customer ? `New message — ${customer}` : 'New message', tone: 'neutral' }
    case 'booking.created': {
      const who = (payload.customer as string | undefined) ?? customer
      return { label: who ? `Booking confirmed — ${who}` : 'Booking confirmed', tone: 'positive' }
    }
    case 'escalation.opened': {
      const cat = payload.category as string | undefined
      return { label: cat ? `Escalated — ${cat}` : 'Escalated', tone: 'alert' }
    }
    case 'escalation.resolved': {
      const cat = payload.category as string | undefined
      return { label: cat ? `Escalation resolved — ${cat}` : 'Escalation resolved', tone: 'positive' }
    }
    case 'channel.disconnected':
      return { label: `${(payload.channel as string | undefined) ?? 'Channel'} disconnected`, tone: 'alert' }
    case 'channel.reconnected':
      return { label: `${(payload.channel as string | undefined) ?? 'Channel'} reconnected`, tone: 'positive' }
    default:
      return { label: type, tone: 'neutral' }
  }
}

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  }

  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user || !isFounderUserId(user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const supabase = createServiceClient()

  // Over-fetch a little: bounced inbound rows are dropped below, so the
  // final list can come up short of the display limit without this.
  const { data, error } = await supabase
    .from('workspace_events')
    .select('id, occurred_at, type, conversation_id, payload')
    .eq('workspace_id', workspaceId)
    .in('type', EVENT_TYPES)
    .order('occurred_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (data ?? []) as RawEvent[]
  const convIds = [...new Set(rows.map((r) => r.conversation_id).filter((v): v is string => !!v))]
  const convContext = new Map<string, { customer: string | null; address: string | null }>()
  if (convIds.length > 0) {
    const { data: convs } = await supabase
      .from('unified_conversations')
      .select('id, customer_name, customer_id')
      .in('id', convIds)
    for (const c of (convs ?? []) as { id: string; customer_name: string | null; customer_id: string | null }[]) {
      convContext.set(c.id, { customer: c.customer_name || c.customer_id, address: c.customer_id })
    }
  }

  const events = rows
    .filter((r) => {
      if (r.type !== 'message.inbound') return true
      const ctx = r.conversation_id ? convContext.get(r.conversation_id) : undefined
      return !isBounceAddress(ctx?.address)
    })
    .slice(0, 8)
    .map((r) => {
      const ctx = r.conversation_id ? convContext.get(r.conversation_id) : undefined
      const { label, tone } = labelFor(r.type, r.payload ?? {}, ctx?.customer ?? null)
      return { id: r.id, at: r.occurred_at, type: r.type, label, tone }
    })

  return NextResponse.json({ events })
}
