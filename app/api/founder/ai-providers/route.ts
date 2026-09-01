/**
 * GET  /api/founder/ai-providers  — provider status + recent routing reality
 * POST /api/founder/ai-providers  — enable/disable, priority, clear circuit, test
 *
 * Internal operator infrastructure. Deliberately founder-only and NOT
 * workspace-scoped: Caye's customers hired an employee, not a model-vendor
 * console, and nothing here should ever appear in a customer workspace.
 *
 * The default posture is "Routing: Auto" — the founder should not have to
 * think about providers at all until one breaks. Everything below exists for
 * the moment it does.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS (same gate as the rest
 * of the founder rail).
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { createServiceClient } from '@/lib/supabase-server'
import {
  AI_PROVIDER_IDS,
  clearProviderCircuit,
  generate,
  isAIProviderId,
  isCircuitOpen,
  loadProviderHealth,
  loadProviderSettings,
  MODELS,
  providerAdapter,
  providerPriorityOverride,
  setProviderEnabled,
  setProviderPriority,
  TASK_ROUTES,
  type AIProviderId,
} from '@/lib/ai'

const ROUTING_LOOKBACK_HOURS = 24

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const [health, settings] = await Promise.all([loadProviderHealth(true), loadProviderSettings(true)])
  const since = new Date(Date.now() - ROUTING_LOOKBACK_HOURS * 3600_000).toISOString()

  const supabase = createServiceClient()
  const { data: rows } = await supabase
    .from('llm_call_log')
    .select('provider, task, outcome, failure_category, fallback_used, latency_ms, input_tokens, output_tokens, called_at')
    .gte('called_at', since)
    .not('provider', 'is', null)
    .limit(20000)

  type Row = {
    provider: AIProviderId
    task: string | null
    outcome: string | null
    failure_category: string | null
    fallback_used: boolean | null
    latency_ms: number | null
  }
  const calls = (rows ?? []) as Row[]

  const providers = AI_PROVIDER_IDS.map((id) => {
    const h = health.get(id)
    const s = settings.get(id)
    const adapter = providerAdapter(id)
    const hasKey = adapter?.hasCredentials() ?? false
    const open = isCircuitOpen(h)
    const mine = calls.filter((c) => c.provider === id)
    const failures = mine.filter((c) => c.outcome === 'failure')

    return {
      id,
      label: LABELS[id],
      enabled: s?.enabled !== false,
      priority: s?.priority ?? null,
      hasCredentials: hasKey,
      envVar: ENV_VARS[id],
      // "unavailable" is a real, explainable state, not a boolean. The point
      // of this surface is answering *why* a provider is not being used.
      status: !hasKey ? 'no_credentials' : s?.enabled === false ? 'disabled' : open ? 'unavailable' : 'healthy',
      reason: open ? h?.reason ?? null : null,
      detail: open ? h?.detail ?? null : null,
      cooldownUntil: open ? h?.cooldownUntil ?? null : null,
      consecutiveFailures: h?.consecutiveFailures ?? 0,
      lastSuccessAt: h?.lastSuccessAt ?? null,
      lastFailureAt: h?.lastFailureAt ?? null,
      models: Object.values(MODELS).filter((m) => m.provider === id).map((m) => ({ id: m.id, tier: m.tier })),
      last24h: {
        calls: mine.length,
        failures: failures.length,
        servedAfterFallback: mine.filter((c) => c.fallback_used).length,
        medianLatencyMs: median(mine.map((c) => c.latency_ms ?? 0).filter(Boolean)),
        topFailure: topValue(failures.map((c) => c.failure_category ?? 'unknown')),
      },
    }
  })

  return NextResponse.json({
    // "Auto" unless someone has actually pinned an order. Surfaced so the UI
    // never claims Auto while an env var is quietly overriding it.
    routingMode: providerPriorityOverride() || providers.some((p) => p.priority !== null) ? 'manual' : 'auto',
    priorityOverrideSource: providerPriorityOverride() ? 'CAYE_AI_PROVIDER_ORDER' : null,
    providers,
    routes: Object.fromEntries(
      Object.entries(TASK_ROUTES).map(([task, keys]) => [
        task,
        keys.map((key) => ({ provider: MODELS[key].provider, model: MODELS[key].id, tier: MODELS[key].tier })),
      ])
    ),
    last24h: {
      calls: calls.length,
      failovers: calls.filter((c) => c.fallback_used).length,
      failures: calls.filter((c) => c.outcome === 'failure').length,
      byTask: rollupByTask(calls),
    },
  })
}

export async function POST(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as {
    action?: string
    provider?: string
    enabled?: boolean
    priority?: number | null
  }
  if (!isAIProviderId(body.provider)) {
    return NextResponse.json({ error: 'Unknown provider' }, { status: 400 })
  }
  const provider = body.provider

  switch (body.action) {
    case 'set_enabled':
      await setProviderEnabled(provider, body.enabled !== false)
      return NextResponse.json({ ok: true })

    case 'set_priority':
      await setProviderPriority(provider, body.priority ?? null)
      return NextResponse.json({ ok: true })

    case 'clear_circuit':
      await clearProviderCircuit(provider)
      return NextResponse.json({ ok: true })

    case 'test': {
      // A real, minimal round trip pinned to this provider. Cheapest model,
      // a handful of tokens: enough to prove credentials and reachability
      // without being a meaningful line on the bill.
      const started = Date.now()
      try {
        const result = await generate({
          params: { model: 'auto', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] },
          ctx: { source: 'app/api/founder/ai-providers/route.ts:test', task: 'classification', pinProvider: provider, callerRole: 'founder' },
        })
        return NextResponse.json({
          ok: true,
          provider,
          model: result.routing.model,
          latencyMs: Date.now() - started,
        })
      } catch (error) {
        const e = error as { category?: string; message?: string }
        return NextResponse.json({
          ok: false,
          provider,
          category: e.category ?? 'unknown',
          // Provider messages can echo request content; keep it short.
          detail: (e.message ?? String(error)).slice(0, 300),
          latencyMs: Date.now() - started,
        })
      }
    }

    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }
}

const LABELS: Record<AIProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
}

const ENV_VARS: Record<AIProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function topValue(values: string[]): string | null {
  if (values.length === 0) return null
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

function rollupByTask(calls: { task: string | null; provider: AIProviderId; fallback_used: boolean | null }[]) {
  const byTask = new Map<string, { calls: number; failovers: number; providers: Record<string, number> }>()
  for (const call of calls) {
    const key = call.task ?? 'untagged'
    const entry = byTask.get(key) ?? { calls: 0, failovers: 0, providers: {} }
    entry.calls += 1
    if (call.fallback_used) entry.failovers += 1
    entry.providers[call.provider] = (entry.providers[call.provider] ?? 0) + 1
    byTask.set(key, entry)
  }
  return Object.fromEntries([...byTask.entries()].sort((a, b) => b[1].calls - a[1].calls))
}
