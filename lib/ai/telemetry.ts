import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { costForModel } from '@/lib/llm-pricing'
import type { AICallContext, AIRouting, AIRoutingAttempt, AIUsage } from './types'

/**
 * One ledger for every AI call.
 *
 * Extends the existing `llm_call_log` rather than opening a second table, so
 * the spend surfaces that already read it (/api/admin/llm-spend,
 * /api/founder/command-overview) keep working and cannot drift from routing
 * reality. New columns are additive and nullable; historical rows stay valid.
 *
 * Every *attempt* is recorded, not just the winner. A failover that nobody
 * can see is indistinguishable from a provider that never fails, which is
 * how a degraded system stays degraded.
 *
 * Boundary rule (Caye safety): this is infrastructure telemetry. It is
 * never read back as business memory, never fed to business learning, and
 * never influences what Caye believes about a customer. It answers "what did
 * this cost and who served it", nothing about the business.
 */
export function usageFromResponse(response: {
  model: string
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
}): AIUsage {
  const usage = response.usage ?? {}
  const inputTokens = usage.input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd: costForModel(response.model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens),
  }
}

interface LogArgs {
  ctx: AICallContext
  routing: AIRouting
  usage?: AIUsage
  outcome: 'success' | 'failure'
  failureCategory?: string
}

/**
 * Fire-and-forget. A telemetry write must never fail or delay a reply —
 * that rule predates this gateway (#49) and is preserved exactly.
 */
export function logAiCall(args: LogArgs): void {
  void writeLog(args).catch((error) => {
    console.error('[ai/telemetry] log write failed:', error instanceof Error ? error.message : String(error))
  })
}

async function writeLog({ ctx, routing, usage, outcome, failureCategory }: LogArgs): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase.from('llm_call_log').insert({
    source: ctx.source,
    model: routing.model,
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    cache_read_tokens: usage?.cacheReadTokens ?? 0,
    cache_creation_tokens: usage?.cacheCreationTokens ?? 0,
    workspace_id: ctx.workspaceId ?? null,
    request_id: ctx.requestId ?? null,
    caller_role: ctx.callerRole ?? null,
    loop_iteration: ctx.loopIteration ?? null,
    provider: routing.provider,
    task: routing.task,
    outcome,
    failure_category: failureCategory ?? null,
    fallback_used: routing.fellBack,
    latency_ms: routing.latencyMs,
    attempts: routing.attempts,
  })
  if (error) throw error
}

/** Structured console line so routing is visible without a database query. */
export function logRoutingDecision(ctx: AICallContext, routing: AIRouting, outcome: 'success' | 'failure'): void {
  if (!routing.fellBack && outcome === 'success') return
  console.info(
    '[ai/gateway]',
    JSON.stringify({
      task: routing.task,
      source: ctx.source,
      workspaceId: ctx.workspaceId ?? null,
      provider: routing.provider,
      model: routing.model,
      outcome,
      fellBack: routing.fellBack,
      latencyMs: routing.latencyMs,
      attempts: routing.attempts.map((a: AIRoutingAttempt) => `${a.provider}/${a.model}:${a.outcome}`),
    })
  )
}
