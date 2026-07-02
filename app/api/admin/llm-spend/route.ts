/**
 * GET /api/admin/llm-spend?days=1
 *
 * Per-source LLM spend aggregation (#49). Dev-only — gated behind the
 * same CRON_SECRET as the poll routes. Answers "which file is 60% of
 * today's bill" without grepping logs.
 *
 * Returns rows ordered by total token spend, with cost computed on
 * read so model price changes don't require backfill.
 *
 * Pricing table is intentionally inline + commented — when new models
 * land or prices shift, update here without touching the writers.
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
    .select('source, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens')
    .gte('called_at', since)
    .limit(50000)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  type Row = {
    source: string
    model: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
  }

  type Agg = {
    source: string
    model: string
    calls: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
    cost_usd: number
  }

  const aggBySourceModel = new Map<string, Agg>()
  for (const r of (data ?? []) as Row[]) {
    const k = `${r.source}|${r.model}`
    let cur = aggBySourceModel.get(k)
    if (!cur) {
      cur = {
        source: r.source,
        model: r.model,
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: 0,
      }
      aggBySourceModel.set(k, cur)
    }
    cur.calls += 1
    cur.input_tokens += r.input_tokens
    cur.output_tokens += r.output_tokens
    cur.cache_read_tokens += r.cache_read_tokens
    cur.cache_creation_tokens += r.cache_creation_tokens
  }

  const rows = Array.from(aggBySourceModel.values())
    .map((a) => ({
      ...a,
      cost_usd: Number(
        costForModel(a.model, a.input_tokens, a.output_tokens, a.cache_read_tokens, a.cache_creation_tokens).toFixed(4)
      ),
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd)

  const totalCost = rows.reduce((acc, r) => acc + r.cost_usd, 0)

  return NextResponse.json({
    window_days: days,
    since,
    total_cost_usd: Number(totalCost.toFixed(4)),
    rows,
  })
}
