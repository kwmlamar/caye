import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from './supabase-server'
import { generate } from './ai/gateway'
import type { AIProviderId, AITask } from './ai/types'

/**
 * Anthropic-shaped facade over the Caye AI Gateway (lib/ai).
 *
 * HISTORY, because the name no longer matches the job. This started as a
 * per-call-site spend wrapper around `client.messages.create` (#49). It was
 * already the one place ~40 call sites funnelled through, so when Caye had to
 * stop treating Claude as infrastructure, this was the correct seam: it kept
 * every call site, prompt, and test mock intact while the thing underneath
 * changed from "the Anthropic SDK" to "route this task to whichever provider
 * can serve it".
 *
 * What that means now:
 *   - This function no longer talks to Anthropic. It calls lib/ai/gateway.
 *   - `params.model` is advisory. The gateway picks the model from the task
 *     route (lib/ai/routes.ts). A call site cannot pin Caye to one vendor.
 *   - The first argument is vestigial and ignored. It is retained so the
 *     existing call sites and the ~30 suites that mock this module by
 *     argument position did not have to be rewritten during a migration
 *     whose whole point was to preserve behaviour. Pass `null`.
 *
 * Spend logging moved into lib/ai/telemetry.ts, which writes the same
 * `llm_call_log` table plus provider/task/routing columns — so
 * /api/admin/llm-spend keeps working and now also sees who served the call.
 */
export interface LoggedCallContext {
  /**
   * `file/path.ts:function` (e.g. `lib/caye-reply.ts:replyLoop`).
   * Distinguishes call sites within a file when more than one exists.
   */
  source: string
  /**
   * The AI capability being requested. Drives routing and cost tier. When
   * omitted it is inferred from `source` (lib/ai/routes.ts) so untagged
   * legacy call sites still route sensibly rather than defaulting to the
   * most expensive profile.
   */
  task?: AITask
  workspaceId?: string | null
  /** Stable top-level request id when the caller has one. Metadata only. */
  requestId?: string | null
  /** Caller role for request-level cost attribution. */
  callerRole?: 'owner' | 'staff' | 'founder' | 'driver' | null
  /** 1-based model turn within a bounded loop. */
  loopIteration?: number | null
  /**
   * Set when a tool with an external side effect may already have run in
   * this turn. Suppresses provider failover — a duplicated customer message
   * or booking write is worse than a surfaced error.
   */
  sideEffectMayHaveOccurred?: boolean
  /**
   * Restrict routing to one provider. Only for surfaces where a vendor was
   * explicitly chosen (Caye Direct's founder model picker) or where the call
   * site genuinely represents that vendor (the research provider adapters).
   * Never on an ordinary product path.
   */
  pinProvider?: AIProviderId
}

export interface GenericLlmUsage {
  model: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

/**
 * @param _provider Ignored. See the module doc comment. Pass `null`.
 */
export async function loggedMessagesCreate(
  _provider: unknown,
  params: Anthropic.MessageCreateParamsNonStreaming,
  ctx: LoggedCallContext,
  options?: { signal?: AbortSignal }
): Promise<Anthropic.Message> {
  const result = await generate({ params, ctx, signal: options?.signal })
  return result.output
}

/**
 * Shared telemetry sink for callers that reach a model outside the gateway
 * (today: lib/research/providers/*, which owns provider-native web search and
 * durable source fetch that the gateway's chat-completion contract does not
 * model). Keeps their spend in the same ledger.
 */
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
