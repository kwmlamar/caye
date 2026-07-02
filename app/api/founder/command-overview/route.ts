/**
 * GET /api/founder/command-overview?workspaceId=<uuid>
 *
 * Founder-only per-workspace overview: recent escalations + a 7-day
 * LLM cost trend. Backs the "Command" tab in CayePanel. Both
 * caye_escalations and llm_call_log have RLS enabled with zero
 * policies (verified 2026-07-01), so this must go through a service-
 * role route rather than a direct client query — nothing would come
 * back otherwise.
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

  const [{ data: escalations, error: escErr }, { data: llmRows, error: llmErr }] = await Promise.all([
    supabase
      .from('caye_escalations')
      .select('id, category, route_to, customer_facing_message, internal_context, created_at, owner_responded_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('llm_call_log')
      .select('model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, called_at')
      .eq('workspace_id', workspaceId)
      .gte('called_at', since.toISOString())
      .limit(20000),
  ])

  if (escErr) return NextResponse.json({ error: escErr.message }, { status: 500 })
  if (llmErr) return NextResponse.json({ error: llmErr.message }, { status: 500 })

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

  const pendingEscalations = (escalations ?? []).filter((e) => !e.owner_responded_at).length

  return NextResponse.json({
    escalations: escalations ?? [],
    pending_escalation_count: pendingEscalations,
    daily_cost: dailyCost,
    total_cost_usd: Number(totalCost.toFixed(4)),
    llm_call_count: (llmRows ?? []).length,
  })
}
