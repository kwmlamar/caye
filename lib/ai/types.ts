import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'

/**
 * Caye AI Gateway — canonical, provider-independent request/response shapes.
 *
 * ARCHITECTURE NOTE (read before "fixing" the Anthropic type import).
 *
 * Caye's canonical wire schema IS the Anthropic Messages content-block
 * schema: `{ role, content: [{type:'text'|'tool_use'|'tool_result'|'image'}] }`.
 * That was not chosen to favour Anthropic — it is what ~40 call sites, the
 * agent tool loop, the persisted `caye_operator_messages.claude_format`
 * column, the replay harness, and every guard in lib/caye-agent already
 * speak. Re-encoding all of that into a new neutral shape during a
 * provider-independence migration would have changed Caye's behaviour, which
 * this work is explicitly not allowed to do.
 *
 * So the types below are sourced from `@anthropic-ai/sdk` as a **type-only**
 * import. That is a compile-time artifact with zero runtime footprint: no
 * client, no key read, no network path. Provider *runtime* SDK usage lives
 * exclusively in `lib/ai/providers/anthropic.ts`. If Anthropic is down,
 * out of credit, or has no key configured, nothing in this file or in any
 * feature module is affected — the gateway routes to OpenAI or OpenRouter
 * and translates in the adapter.
 *
 * The rule this enforces: feature code owns *what to ask*, the gateway owns
 * *who answers*.
 */

/** Providers Caye can route to. Adding one means adding an adapter. */
export type AIProviderId = 'anthropic' | 'openai' | 'openrouter'

export const AI_PROVIDER_IDS: readonly AIProviderId[] = ['anthropic', 'openai', 'openrouter'] as const

export function isAIProviderId(value: unknown): value is AIProviderId {
  return typeof value === 'string' && (AI_PROVIDER_IDS as readonly string[]).includes(value)
}

/**
 * What Caye is asking for, not which model answers it. Routing, capability
 * requirements and cost tier are all derived from this.
 *
 * Deliberately mapped onto Caye's real surfaces rather than generic LLM
 * verbs, so a route change is a product decision someone can reason about.
 */
export type AITask =
  /** Front-desk text that a paying customer's guest will read. */
  | 'customer_response'
  /** Back-office/operator/founder conversational replies. */
  | 'operator_response'
  /** The bounded tool loop — planning + tool selection + execution turns. */
  | 'agent_planning'
  /** Pulling durable business facts out of conversation/email. */
  | 'fact_extraction'
  /** Briefings, insights, revenue/attention analysis. */
  | 'business_analysis'
  /** Noticing a commercial opening worth surfacing. */
  | 'opportunity_detection'
  /** Cheap, high-volume label/intent/routing decisions. */
  | 'classification'
  /** Condensing history/threads without losing load-bearing detail. */
  | 'summarization'
  /** Web/desk research synthesis. */
  | 'research'
  /** Workspace onboarding conversation. */
  | 'onboarding'
  /** Cold outreach drafting. */
  | 'outreach'
  /** Uncategorised. Routes on the general-purpose profile. */
  | 'other'

export const AI_TASKS: readonly AITask[] = [
  'customer_response',
  'operator_response',
  'agent_planning',
  'fact_extraction',
  'business_analysis',
  'opportunity_detection',
  'classification',
  'summarization',
  'research',
  'onboarding',
  'outreach',
  'other',
] as const

export function isAITask(value: unknown): value is AITask {
  return typeof value === 'string' && (AI_TASKS as readonly string[]).includes(value)
}

/** Capabilities a model must actually have for a request to be routable to it. */
export type AICapability =
  | 'tool_use'
  | 'structured_output'
  | 'vision'
  | 'streaming'
  | 'long_context'
  /**
   * Not a model feature flag like the others — a routing *reason*, reported
   * when a model cannot accept the number of tool definitions in the request.
   * Providers cap the tools array (OpenAI: 128, observed 2026-09-01), and a
   * cap is per-provider, so a request one provider rejects another can serve.
   */
  | 'tool_capacity'

/**
 * Canonical message/params shape. Anthropic-schema'd — see the file header.
 * `AIMessageParams` is deliberately assignable from the Anthropic SDK's own
 * non-streaming params so no call site had to be rewritten.
 */
export type AIMessage = Anthropic.MessageParam
export type AIContentBlock = Anthropic.ContentBlockParam
export type AITool = Anthropic.Tool
export type AIMessageParams = Anthropic.MessageCreateParamsNonStreaming
export type AIResponseMessage = Anthropic.Message

/** Who/what the call is for. Drives routing, telemetry and spend attribution. */
export interface AICallContext {
  /**
   * `file/path.ts:function`. Retained from the original spend-attribution
   * wrapper (#49) so per-call-site cost history stays continuous.
   */
  source: string
  /** The capability being requested. Defaults to inference from `source`, then 'other'. */
  task?: AITask
  workspaceId?: string | null
  requestId?: string | null
  callerRole?: 'owner' | 'staff' | 'founder' | 'driver' | null
  loopIteration?: number | null
  /**
   * True when a tool with an external side effect may already have run in
   * this turn. Suppresses failover — a duplicated send is worse than a
   * surfaced error. Mirrors the existing model-router rule.
   */
  sideEffectMayHaveOccurred?: boolean
  /**
   * Restrict routing to one provider (still failing over between that
   * provider's models). Used by surfaces where the founder has explicitly
   * chosen a vendor — Caye Direct's `claude`/`openai` modes — and by the
   * admin "test this provider" action. Never set on ordinary product paths:
   * pinning is how you re-create the single-vendor outage this gateway
   * exists to survive.
   */
  pinProvider?: AIProviderId
}

export interface AIRoutingAttempt {
  provider: AIProviderId
  model: string
  outcome: 'success' | AIErrorCategory | 'skipped_disabled' | 'skipped_no_credentials' | 'skipped_capability' | 'skipped_circuit_open'
  detail?: string
  latencyMs?: number
}

export interface AIRouting {
  task: AITask
  provider: AIProviderId
  model: string
  attempts: AIRoutingAttempt[]
  /** True when the request was served by anything other than the first eligible route. */
  fellBack: boolean
  latencyMs: number
}

export interface AIUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
}

export interface AIResult {
  /** Normalized, provider-independent output in Caye's canonical block shape. */
  output: AIResponseMessage
  usage: AIUsage
  routing: AIRouting
}

/**
 * Error taxonomy. `retryable` (same provider, bounded) and `failover`
 * (next provider) are properties of the *category*, not of the call site,
 * so the policy is one table instead of scattered try/catch judgement.
 */
export type AIErrorCategory =
  | 'billing_exhausted'
  | 'authentication'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'upstream_5xx'
  | 'malformed_request'
  | 'unsupported_capability'
  | 'invalid_tool_or_schema'
  | 'context_length_exceeded'
  | 'content_policy'
  | 'side_effect_may_have_occurred'
  | 'unknown'

export class AIProviderError extends Error {
  readonly name = 'AIProviderError'
  constructor(
    readonly category: AIErrorCategory,
    message: string,
    readonly opts: {
      provider?: AIProviderId
      model?: string
      httpStatus?: number
      retryAfterMs?: number
      cause?: unknown
    } = {}
  ) {
    super(message)
  }
}

/** Raised when every eligible route was exhausted. Carries the full trail. */
export class NoAIProviderAvailableError extends Error {
  readonly name = 'NoAIProviderAvailableError'
  constructor(readonly task: AITask, readonly attempts: AIRoutingAttempt[], readonly lastError?: AIProviderError) {
    super(
      attempts.length === 0
        ? `No AI provider is configured for task "${task}". Set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY.`
        : `All AI providers failed for task "${task}". Tried: ${attempts
            .map((a) => `${a.provider}/${a.model} (${a.outcome})`)
            .join(', ')}.`
    )
  }
}

/** A provider adapter. The only place a vendor SDK/wire format may appear. */
export interface AIProviderAdapter {
  readonly id: AIProviderId
  /** True when this provider has usable credentials right now. Never spends a prompt. */
  hasCredentials(): boolean
  /**
   * Stable fingerprint of the credential in use, so a circuit opened on a
   * billing/auth failure can close itself when the key is rotated rather
   * than waiting out a long cooldown. Never the key itself.
   */
  credentialFingerprint(): string
  /** Can this provider/model serve this request as written? */
  supports(params: AIMessageParams, model: string): { ok: true } | { ok: false; missing: AICapability }
  generate(params: AIMessageParams, model: string, signal?: AbortSignal): Promise<AIResponseMessage>
  classifyError(error: unknown): AIProviderError
}
