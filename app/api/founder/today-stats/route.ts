/**
 * GET /api/founder/today-stats?workspaceId=<uuid>
 *
 * Real counts for the Home hero's one-sentence briefing ("answered 7
 * customers today"). Reads workspace_events for today's UTC-day window and
 * counts by type — a supplement to command-overview's week-scoped numbers,
 * not a replacement.
 *
 * message.outbound is intentionally counted here even though it's excluded
 * from /api/founder/live-events' curated feed (too noisy to show row by
 * row) — a count is a different thing from a list, and the briefing needs
 * the count, not the messages themselves.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'

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
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  const { data, error } = await supabase
    .from('workspace_events')
    .select('type, actor_kind')
    .eq('workspace_id', workspaceId)
    .gte('occurred_at', startOfDay.toISOString())
    .in('type', ['message.outbound', 'message.inbound', 'booking.created', 'escalation.resolved'])
    .limit(2000)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let customersAnswered = 0
  let customersWroteIn = 0
  let bookingsToday = 0
  let escalationsResolvedToday = 0
  for (const row of data ?? []) {
    if (row.type === 'message.outbound' && row.actor_kind === 'caye') customersAnswered++
    else if (row.type === 'message.inbound') customersWroteIn++
    else if (row.type === 'booking.created') bookingsToday++
    else if (row.type === 'escalation.resolved') escalationsResolvedToday++
  }

  return NextResponse.json({ customersAnswered, customersWroteIn, bookingsToday, escalationsResolvedToday })
}
