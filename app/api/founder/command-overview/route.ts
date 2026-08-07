/**
 * GET /api/founder/command-overview?workspaceId=<uuid>
 *
 * Founder-only per-workspace overview: escalations, a 7-day LLM cost
 * trend, and this week's real bookings. Backs FounderHome's stat strip
 * and CommandCalendar.
 *
 * Conversations used to be fetched here too, capped at a flat N most
 * recent — that silently hid older held conversations and made the
 * founder-facing search/Review tab operate on a partial window. They
 * now live behind their own paginated, searchable route:
 * GET /api/founder/conversations (2026-07-30).
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
import { getAttentionHoldCount } from '@/lib/hold-kinds'

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

  const [
    { data: escalations, error: escErr },
    { data: llmRows, error: llmErr },
    { data: bookingsRows, error: bookingsErr },
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
    supabase
      .from('workspace_ai_config')
      .select('whatsapp_muted_until')
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
  ])

  if (escErr) return NextResponse.json({ error: escErr.message }, { status: 500 })
  if (llmErr) return NextResponse.json({ error: llmErr.message }, { status: 500 })
  if (bookingsErr) return NextResponse.json({ error: bookingsErr.message }, { status: 500 })

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

  // "Needs review" is deliberately NOT "open caye_escalations rows" — that
  // definition drifts from what the Review tab (founder/conversations)
  // shows, because the two are only kept in sync by every hold-clearing
  // call site remembering to call resolveOpenEscalations, and escalation
  // bookkeeping can legitimately expire (stop nagging) while the
  // underlying hold is still real and unresolved (see
  // expireEscalationBookkeepingOnly's doc comment). Confirmed live
  // 2026-08-07 on Bimini: the stat card and the Review tab both read "2"
  // by coincidence while counting two different threads each — one
  // (Jonathan Garcia) whose hold had been manually cleared without the
  // escalation being closed, the other (Sue Guilbert) whose escalation
  // bookkeeping expired 2026-08-01 while her thread has sat held since
  // 2026-07-25.
  //
  // The canonical definition, matching founder/conversations' reviewCount
  // and the agent-side get_held_queue (lib/hold-kinds.ts): a held,
  // non-archived conversation that isn't a queued outreach draft awaiting
  // batch approval. Both cards now read this same thing.
  const pendingEscalations = await getAttentionHoldCount(supabase, workspaceId)

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

  // "Active" mirrors the mute gate the reply pipeline itself checks (see
  // app/api/email/poll/route.ts's "Caye-wide mute gate" comment). The old
  // whatsapp_outbound_enabled field this replaced is a one-way "onboarding
  // finished" flag, never re-toggled, so it couldn't reflect a back-office
  // mute/unmute no matter what the UI did.
  //
  // Deliberately NOT also checking workspace_ai_config.ai_enabled here:
  // whatsapp_muted_until is what mute_caye/unmute_caye actually write, so
  // it's the field that reflects a back-office mute. ai_enabled is a
  // separate, coarser kill switch.
  //
  // History worth keeping: from 2026-05-24 to 2026-07-28 the ai_enabled
  // column didn't exist in production at all (its migration was written
  // but never applied), so every `.select(...ai_enabled)` across the
  // webhooks, nudge-scan and email poll 400'd — taking system_prompt down
  // with it and failing open. The column exists now (default true, so no
  // workspace's behaviour changed when it landed); this exclusion is a
  // deliberate choice about what "muted" means here, not a workaround.
  const mutedUntil = aiConfig?.whatsapp_muted_until ?? null
  const isMuted = !!mutedUntil && new Date(mutedUntil).getTime() > Date.now()
  const cayeActive = !isMuted

  return NextResponse.json({
    escalations: escalations ?? [],
    pending_escalation_count: pendingEscalations,
    daily_cost: dailyCost,
    total_cost_usd: Number(totalCost.toFixed(4)),
    llm_call_count: (llmRows ?? []).length,
    bookings,
    week_start: monday.toISOString().slice(0, 10),
    week_offset: weekOffset,
    caye_active: cayeActive,
    caye_muted_until: isMuted ? mutedUntil : null,
  })
}
