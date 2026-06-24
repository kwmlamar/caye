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
}

export async function loggedMessagesCreate(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  ctx: LoggedCallContext
): Promise<Anthropic.Message> {
  const response = await client.messages.create(params)
  void logCallUsage(response, ctx).catch((err) => {
    console.error('[llm-telemetry] log write failed:', err)
  })
  return response
}

async function logCallUsage(
  response: Anthropic.Message,
  ctx: LoggedCallContext
): Promise<void> {
  const supabase = createServiceClient()
  const usage = response.usage
  await supabase.from('llm_call_log').insert({
    source: ctx.source,
    model: response.model,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
    workspace_id: ctx.workspaceId ?? null,
  })
}
