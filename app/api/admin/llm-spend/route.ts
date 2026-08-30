/**
 * GET /api/admin/llm-spend?days=1
 *
 * Founder/dev spend observability. Returns both per-call-site and
 * per-workspace rollups so customer automation spend is not blended into
 * founder testing. Gated behind CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { costForModel } from '@/lib/llm-pricing'

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const provided =
      req.headers.get('x-cron-secret') ||
      req.headers.get('authorization')?.replace('Bearer ', '')
    if (provided !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const url = new URL(req.url)
  const days = Math.max(1, Math.min(30, Number(url.searchParams.get('days') ?? '1')))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('llm_call_log')
    .select('source, model, workspace_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens')
    .gte('called_at', since)
    .limit(50000)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  type Row = {
    source: string
    model: string
    workspace_id: string | null
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
  }

  type Agg = {
    source: string
    model: string
    workspace_id: string | null
    calls: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
    cost_usd: number
  }

  const rowsIn = (data ?? []) as Row[]
  const workspaceIds = [...new Set(rowsIn.map((r) => r.workspace_id).filter((id): id is string => Boolean(id)))]
  const workspaceNames = new Map<string, string>()
  if (workspaceIds.length > 0) {
    const { data: customers } = await supabase
      .from('customers')
      .select('id, business_name')
      .in('id', workspaceIds)
    for (const customer of customers ?? []) {
      workspaceNames.set(customer.id as string, (customer.business_name as string | null) || 'Unnamed workspace')
    }
  }

  const aggBySourceModelWorkspace = new Map<string, Agg>()
  for (const r of rowsIn) {
    const k = `${r.workspace_id ?? 'unattributed'}|${r.source}|${r.model}`
    let cur = aggBySourceModelWorkspace.get(k)
    if (!cur) {
      cur = {
        source: r.source,
        model: r.model,
        workspace_id: r.workspace_id,
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: 0,
      }
      aggBySourceModelWorkspace.set(k, cur)
    }
    cur.calls += 1
    cur.input_tokens += r.input_tokens
    cur.output_tokens += r.output_tokens
    cur.cache_read_tokens += r.cache_read_tokens
    cur.cache_creation_tokens += r.cache_creation_tokens
  }

  const rows = Array.from(aggBySourceModelWorkspace.values())
    .map((a) => ({
      ...a,
      workspace_name: a.workspace_id ? workspaceNames.get(a.workspace_id) ?? 'Unknown workspace' : 'Unattributed',
      cost_usd: Number(
        costForModel(a.model, a.input_tokens, a.output_tokens, a.cache_read_tokens, a.cache_creation_tokens).toFixed(4)
      ),
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd)

  const byWorkspace = new Map<string, {
    workspace_id: string | null
    workspace_name: string
    calls: number
    cost_usd: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
  }>()

  for (const row of rows) {
    const key = row.workspace_id ?? 'unattributed'
    const current = byWorkspace.get(key) ?? {
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name,
      calls: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    }
    current.calls += row.calls
    current.cost_usd += row.cost_usd
    current.input_tokens += row.input_tokens
    current.output_tokens += row.output_tokens
    current.cache_read_tokens += row.cache_read_tokens
    current.cache_creation_tokens += row.cache_creation_tokens
    byWorkspace.set(key, current)
  }

  const workspaces = Array.from(byWorkspace.values())
    .map((w) => ({ ...w, cost_usd: Number(w.cost_usd.toFixed(4)) }))
    .sort((a, b) => b.cost_usd - a.cost_usd)
  const totalCost = rows.reduce((acc, r) => acc + r.cost_usd, 0)

  return NextResponse.json({
    window_days: days,
    since,
    total_cost_usd: Number(totalCost.toFixed(4)),
    workspaces,
    rows,
  })
}
