import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from './supabase-server'

/**
 * Per-call-site LLM spend attribution (#49). Thin wrapper around
 * client.messages.create that records source, model, and token usage
 * to `llm_call_log` for spend-by-file aggregation.
 *
 * Log writes are fire-and-forget — a logging failure must never block
 * the reply. Errors are surfaced via console only.
 *
 * Source string convention: `file/path.ts:function` (e.g.
 * `lib/caye-reply.ts:replyLoop`). Distinguishes call sites within a
 * file when more than one exists.
 */
export interface LoggedCallContext {
  source: string
  workspaceId?: string | null
  /** Stable top-level request id when the caller has one. Metadata only. */
  requestId?: string | null
  /** Caller role for request-level cost attribution. */
  callerRole?: 'owner' | 'staff' | 'founder' | 'driver' | null
  /** 1-based model turn within a bounded loop. */
  loopIteration?: number | null
}

export interface GenericLlmUsage {
  model: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export async function loggedMessagesCreate(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  ctx: LoggedCallContext,
  options?: Anthropic.RequestOptions
): Promise<Anthropic.Message> {
  const response = await client.messages.create(params, options)
  void logCallUsage(response, ctx).catch((err) => {
    console.error('[llm-telemetry] log write failed:', err)
  })
  return response
}

/** Shared telemetry sink for non-Anthropic backends so cloud spend stays visible. */
export async function logGenericLlmUsage(usage: GenericLlmUsage, ctx: LoggedCallContext): Promise<void> {
  const supabase = createServiceClient()
  await supabase.from('llm_call_log').insert({
    source: ctx.source,
    model: usage.model,
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cache_read_tokens: usage.cacheReadTokens ?? 0,
    cache_creation_tokens: usage.cacheCreationTokens ?? 0,
    workspace_id: ctx.workspaceId ?? null,
    request_id: ctx.requestId ?? null,
    caller_role: ctx.callerRole ?? null,
    loop_iteration: ctx.loopIteration ?? null,
  })
}

async function logCallUsage(
  response: Anthropic.Message,
  ctx: LoggedCallContext
): Promise<void> {
  const usage = response.usage
  await logGenericLlmUsage(
    {
      model: response.model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? undefined,
    },
    ctx
  )
}
