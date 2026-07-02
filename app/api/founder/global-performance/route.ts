/**
 * GET /api/founder/global-performance
 * GET /api/founder/global-performance?detailWorkspaceId=<uuid>
 *
 * Cross-workspace cost + usage table for the founder's "Global
 * Performance" rail tab — one row per workspace the founder is a member
 * of (same set as the Placements sidebar), with real 7-day LLM API cost
 * and call volume. Deliberately no revenue/margin column: customer.plan
 * and stripe_subscription_id aren't reliably populated per workspace
 * (e.g. Bimini's actual $79/mo only exists as a Stripe Payment Link +
 * a note, not a DB field) — showing a fake number would be worse than
 * showing none. Read-only; no actions.
 *
 * detailWorkspaceId switches to a single-workspace daily cost trend
 * (last DETAIL_WINDOW_DAYS days) for the row-expand panel, instead of
 * the cross-workspace summary.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'
import { costForModel } from '@/lib/llm-pricing'

const WINDOW_DAYS = 7
const DETAIL_WINDOW_DAYS = 30

async function getDailyCostTrend(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string
) {
  const since = new Date(Date.now() - DETAIL_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const { data: llmRows, error } = await supabase
    .from('llm_call_log')
    .select('model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, called_at')
    .eq('workspace_id', workspaceId)
    .gte('called_at', since.toISOString())
    .limit(50000)

  if (error) return { error: error.message }

  const dayBuckets = new Map<string, { cost_usd: number; calls: number }>()
  for (let i = DETAIL_WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
    dayBuckets.set(d.toISOString().slice(0, 10), { cost_usd: 0, calls: 0 })
  }

  for (const r of llmRows ?? []) {
    const day = (r.called_at as string).slice(0, 10)
    const bucket = dayBuckets.get(day)
    if (!bucket) continue
    bucket.calls += 1
    bucket.cost_usd += costForModel(
      r.model,
      r.input_tokens ?? 0,
      r.output_tokens ?? 0,
      r.cache_read_tokens ?? 0,
      r.cache_creation_tokens ?? 0
    )
  }

  const daily = Array.from(dayBuckets.entries()).map(([day, v]) => ({
    day,
    cost_usd: Number(v.cost_usd.toFixed(4)),
    calls: v.calls,
  }))

  return { daily }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user || !isFounderUserId(user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const supabase = createServiceClient()

  const detailWorkspaceId = req.nextUrl.searchParams.get('detailWorkspaceId')
  if (detailWorkspaceId) {
    const { data: membership } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', user.id)
      .eq('workspace_id', detailWorkspaceId)
      .maybeSingle()
    if (!membership) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const result = await getDailyCostTrend(supabase, detailWorkspaceId)
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: 500 })
    return NextResponse.json({ window_days: DETAIL_WINDOW_DAYS, workspace_id: detailWorkspaceId, daily: result.daily })
  }

  const { data: memberships, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id, customer:customers(id, business_name, status)')
    .eq('user_id', user.id)

  if (memberErr) return NextResponse.json({ error: memberErr.message }, { status: 500 })

  type MembershipRow = { workspace_id: string; customer: { id: string; business_name: string; status: string } | null }
  const workspaceRows = ((memberships ?? []) as unknown as MembershipRow[])
    .filter((m): m is MembershipRow & { customer: NonNullable<MembershipRow['customer']> } => m.customer !== null)

  const workspaceIds = workspaceRows.map((m) => m.workspace_id)
  if (workspaceIds.length === 0) {
    return NextResponse.json({ window_days: WINDOW_DAYS, workspaces: [] })
  }

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { data: llmRows, error: llmErr } = await supabase
    .from('llm_call_log')
    .select('workspace_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens')
    .in('workspace_id', workspaceIds)
    .gte('called_at', since)
    .limit(50000)

  if (llmErr) return NextResponse.json({ error: llmErr.message }, { status: 500 })

  const agg = new Map<string, { calls: number; cost_usd: number }>()
  for (const r of llmRows ?? []) {
    const cur = agg.get(r.workspace_id) ?? { calls: 0, cost_usd: 0 }
    cur.calls += 1
    cur.cost_usd += costForModel(
      r.model,
      r.input_tokens ?? 0,
      r.output_tokens ?? 0,
      r.cache_read_tokens ?? 0,
      r.cache_creation_tokens ?? 0
    )
    agg.set(r.workspace_id, cur)
  }

  const workspacesOut = workspaceRows
    .map((m) => {
      const stats = agg.get(m.workspace_id) ?? { calls: 0, cost_usd: 0 }
      return {
        workspace_id: m.workspace_id,
        business_name: m.customer.business_name,
        status: m.customer.status,
        call_count: stats.calls,
        cost_usd: Number(stats.cost_usd.toFixed(4)),
      }
    })
    .sort((a, b) => b.cost_usd - a.cost_usd)

  return NextResponse.json({ window_days: WINDOW_DAYS, workspaces: workspacesOut })
}
