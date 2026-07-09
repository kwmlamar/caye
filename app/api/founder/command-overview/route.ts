/**
 * GET /api/founder/command-overview?workspaceId=<uuid>
 *
 * Founder-only per-workspace overview: escalations, a 7-day LLM cost
 * trend, this week's real bookings, and recent front-desk conversations
 * (unified_conversations/unified_messages, joined through
 * connected_accounts). Backs FounderHome's stat strip, CommandCalendar,
 * and CommandConversations (2026-07-02 data-wiring pass — those two
 * were frontend-first with mock data until now).
 *
 * All of this goes through a single service-role route rather than
 * direct client queries: caye_escalations and llm_call_log have RLS
 * enabled with zero policies (verified 2026-07-01), and even where
 * policies exist (bookings, unified_conversations) they're not
 * necessarily founder-cross-workspace-aware, so one audited path is
 * safer than partially trusting RLS in five different places.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'
import { costForModel } from '@/lib/llm-pricing'

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  }

  // Weeks away from the current one — CommandCalendar's prev/next nav.
  // 0 = this week (the only value this route supported before).
  const weekOffsetParam = req.nextUrl.searchParams.get('weekOffset')
  const weekOffset = weekOffsetParam ? parseInt(weekOffsetParam, 10) || 0 : 0

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
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  // Monday–Sunday of the requested week (matches CommandCalendar's
  // Mon–Sun grid). weekOffset shifts whole weeks earlier/later.
  const now = new Date()
  const dow = now.getDay() // 0 = Sunday
  const mondayOffset = dow === 0 ? -6 : 1 - dow
  const monday = new Date(now)
  monday.setHours(0, 0, 0, 0)
  monday.setDate(now.getDate() + mondayOffset + weekOffset * 7)
  const nextMonday = new Date(monday)
  nextMonday.setDate(monday.getDate() + 7)

  const connectedAccountIds = await supabase
    .from('connected_accounts')
    .select('id')
    .eq('user_id', workspaceId)
    .then((r) => (r.data ?? []).map((a) => a.id))

  const [
    { data: escalations, error: escErr },
    { data: llmRows, error: llmErr },
    { data: bookingsRows, error: bookingsErr },
    { data: conversationsRows, error: convErr },
    { data: aiConfig },
  ] = await Promise.all([
    supabase
      .from('caye_escalations')
      .select('id, conversation_id, category, route_to, customer_facing_message, internal_context, created_at, owner_responded_at, expired_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('llm_call_log')
      .select('model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, called_at')
      .eq('workspace_id', workspaceId)
      .gte('called_at', since.toISOString())
      .limit(20000),
    supabase
      .from('bookings')
      .select('id, customer_name, booking_date, booking_time, status, number_of_people, payment_confirmed_at, conversation_id, service:booking_services(name)')
      .eq('user_id', workspaceId)
      .gte('booking_date', monday.toISOString().slice(0, 10))
      .lt('booking_date', nextMonday.toISOString().slice(0, 10))
      .neq('status', 'cancelled')
      .order('booking_date', { ascending: true }),
    connectedAccountIds.length
      ? supabase
          .from('unified_conversations')
          .select('id, channel_type, customer_name, last_message_preview, last_message_at, human_agent_enabled, human_agent_reason')
          .in('connected_account_id', connectedAccountIds)
          .order('last_message_at', { ascending: false })
          .limit(30)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from('workspace_ai_config')
      .select('whatsapp_outbound_enabled')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
  ])

  if (escErr) return NextResponse.json({ error: escErr.message }, { status: 500 })
  if (llmErr) return NextResponse.json({ error: llmErr.message }, { status: 500 })
  if (bookingsErr) return NextResponse.json({ error: bookingsErr.message }, { status: 500 })
  if (convErr) return NextResponse.json({ error: convErr.message }, { status: 500 })

  // Bucket cost by day (UTC date) for a 7-point trend, oldest first.
  const dayBuckets = new Map<string, number>()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
    dayBuckets.set(d.toISOString().slice(0, 10), 0)
  }

  let totalCost = 0
  for (const row of llmRows ?? []) {
    const cost = costForModel(
      row.model,
      row.input_tokens ?? 0,
      row.output_tokens ?? 0,
      row.cache_read_tokens ?? 0,
      row.cache_creation_tokens ?? 0
    )
    totalCost += cost
    const day = (row.called_at as string).slice(0, 10)
    if (dayBuckets.has(day)) {
      dayBuckets.set(day, (dayBuckets.get(day) ?? 0) + cost)
    }
  }

  const dailyCost = Array.from(dayBuckets.entries()).map(([day, cost]) => ({
    day,
    cost_usd: Number(cost.toFixed(4)),
  }))

  const pendingEscalations = (escalations ?? []).filter(
    (e) => !e.owner_responded_at && !e.expired_at
  ).length

  // Conversation IDs with an escalation still waiting on the
  // owner/founder — used to flag bookings whose customer has an open
  // issue, so CommandCalendar can surface it without a second query.
  // Excludes expired escalations (target date passed, one-shot closing
  // note already sent) — those aren't "open" in any actionable sense.
  const openEscalationConversationIds = new Set(
    (escalations ?? [])
      .filter((e) => !e.owner_responded_at && !e.expired_at && e.conversation_id)
      .map((e) => e.conversation_id as string)
  )

  interface BookingRow {
    id: string
    customer_name: string
    booking_date: string
    booking_time: string
    status: string
    number_of_people: number
    payment_confirmed_at: string | null
    conversation_id: string | null
    service: { name: string }[] | { name: string } | null
  }

  const bookings = ((bookingsRows ?? []) as unknown as BookingRow[]).map((b) => ({
    id: b.id,
    customer_name: b.customer_name,
    booking_date: b.booking_date,
    booking_time: b.booking_time,
    status: b.status,
    number_of_people: b.number_of_people,
    payment_confirmed: !!b.payment_confirmed_at,
    conversation_id: b.conversation_id,
    service_name: Array.isArray(b.service) ? (b.service[0]?.name ?? null) : (b.service?.name ?? null),
    has_open_escalation: !!b.conversation_id && openEscalationConversationIds.has(b.conversation_id),
  }))

  return NextResponse.json({
    escalations: escalations ?? [],
    pending_escalation_count: pendingEscalations,
    daily_cost: dailyCost,
    total_cost_usd: Number(totalCost.toFixed(4)),
    llm_call_count: (llmRows ?? []).length,
    bookings,
    week_start: monday.toISOString().slice(0, 10),
    week_offset: weekOffset,
    conversations: conversationsRows ?? [],
    whatsapp_outbound_enabled: aiConfig?.whatsapp_outbound_enabled ?? false,
  })
}
