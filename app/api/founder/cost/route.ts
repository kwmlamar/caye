/**
 * GET /api/founder/cost
 *
 * Cross-workspace "what does it cost to run Caye, and is that workspace
 * profitable" view for the founder's "Cost" rail tab. One row per
 * workspace the founder is a member of (same set as the Workspaces
 * sidebar and /api/founder/global-performance).
 *
 * Phase 1 (this route): real LLM/Anthropic cost (7-day and 30-day) from
 * llm_call_log, same costForModel pricing table used everywhere else
 * (lib/llm-pricing.ts). Monthly price comes from the manually-maintained
 * lib/workspace-pricing.ts map — no Stripe sync exists in this repo, so
 * margin is only as good as that map being kept current.
 *
 * Phase 2 (not yet built): Meta/WhatsApp conversation-based pricing.
 * Nothing in this repo tracks that today — no credentials, no sync job,
 * no table — so meta_cost_usd is an explicit `null` ("not tracked yet"),
 * never a fabricated 0. Margin is LLM-cost-only until that lands.
 *
 * Split out of /api/founder/global-performance (2026-07-28), which used
 * to render this same LLM-cost table before Cost/Health became their own
 * pages — see that route's comment.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { requireFounder } from '@/lib/founder'
import { costForModel } from '@/lib/llm-pricing'
import { monthlyPriceForWorkspace } from '@/lib/workspace-pricing'

const SHORT_WINDOW_DAYS = 7
const LONG_WINDOW_DAYS = 30

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const supabase = createServiceClient()

  const { data: memberships, error: memberErr } = await supabase
    .from('workspace_members')
    .select('workspace_id, customer:customers(id, business_name, status)')
    .eq('user_id', user.id)

  if (memberErr) return NextResponse.json({ error: memberErr.message }, { status: 500 })

  type MembershipRow = { workspace_id: string; customer: { id: string; business_name: string | null; status: string } | null }
  const workspaceRows = ((memberships ?? []) as unknown as MembershipRow[])
    .filter((m): m is MembershipRow & { customer: NonNullable<MembershipRow['customer']> } => m.customer !== null)

  const workspaceIds = workspaceRows.map((m) => m.workspace_id)
  if (workspaceIds.length === 0) {
    return NextResponse.json({ short_window_days: SHORT_WINDOW_DAYS, long_window_days: LONG_WINDOW_DAYS, workspaces: [] })
  }

  const shortSince = new Date(Date.now() - SHORT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const longSince = new Date(Date.now() - LONG_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { data: llmRows, error: llmErr } = await supabase
    .from('llm_call_log')
    .select('workspace_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, called_at')
    .in('workspace_id', workspaceIds)
    .gte('called_at', longSince)
    .limit(100000)

  if (llmErr) return NextResponse.json({ error: llmErr.message }, { status: 500 })

  const agg = new Map<string, { cost7d: number; cost30d: number; calls7d: number; calls30d: number }>()
  for (const r of llmRows ?? []) {
    const cur = agg.get(r.workspace_id) ?? { cost7d: 0, cost30d: 0, calls7d: 0, calls30d: 0 }
    const cost = costForModel(
      r.model,
      r.input_tokens ?? 0,
      r.output_tokens ?? 0,
      r.cache_read_tokens ?? 0,
      r.cache_creation_tokens ?? 0
    )
    cur.cost30d += cost
    cur.calls30d += 1
    if ((r.called_at as string) >= shortSince) {
      cur.cost7d += cost
      cur.calls7d += 1
    }
    agg.set(r.workspace_id, cur)
  }

  const workspacesOut = workspaceRows
    .map((m) => {
      const stats = agg.get(m.workspace_id) ?? { cost7d: 0, cost30d: 0, calls7d: 0, calls30d: 0 }
      const monthlyPrice = monthlyPriceForWorkspace(m.workspace_id)
      const llmCost30d = Number(stats.cost30d.toFixed(4))
      return {
        workspace_id: m.workspace_id,
        business_name: m.customer.business_name ?? 'New signup',
        status: m.customer.status,
        llm_cost_7d_usd: Number(stats.cost7d.toFixed(4)),
        llm_cost_30d_usd: llmCost30d,
        llm_calls_30d: stats.calls30d,
        meta_cost_30d_usd: null, // not tracked yet — see route comment
        monthly_price_usd: monthlyPrice,
        margin_usd: monthlyPrice === null ? null : Number((monthlyPrice - llmCost30d).toFixed(2)),
      }
    })
    .sort((a, b) => (b.monthly_price_usd ?? 0) - (a.monthly_price_usd ?? 0))

  return NextResponse.json({
    short_window_days: SHORT_WINDOW_DAYS,
    long_window_days: LONG_WINDOW_DAYS,
    workspaces: workspacesOut,
  })
}
