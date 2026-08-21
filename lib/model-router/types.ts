import 'server-only'

/**
 * Caye Direct multi-model router — shared types.
 *
 * Scope: Lamar's founder-only reasoning surface in Caye Direct ONLY.
 * Nothing here is wired into lib/caye-agent/execute.ts (the shared
 * runToolLoop used by WhatsApp operator traffic and the converged
 * front-desk runtime) — see docs/agents/model-router.md for why.
 */

export type BackendId =
  | 'claude_subscription'
  | 'openai_codex_subscription'
  | 'anthropic_api'
  | 'openai_api'

export type RequestedMode = 'auto' | 'claude' | 'openai' | 'api'

export type Capability =
  | 'general_reasoning'
  | 'coding'
  | 'tool_use'
  | 'long_context'
  | 'vision'
  | 'structured_output'
  | 'streaming'
  | 'persisted_session'
  | 'local_repo_access'

/**
 * Availability states a backend can report. Distinct from a boolean so the
 * router and UI can explain *why* a backend was skipped instead of just
 * that it was.
 */
export type BackendState =
  | 'available'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'auth_required'
  | 'unavailable' // structural: binary missing, not on this machine, bridge unreachable
  | 'healthy' // returned by health checks that don't map to the above

export interface BackendHealth {
  state: BackendState
  /** Human-readable reason, safe to show Lamar in the UI. Never a raw error/stack. */
  detail?: string
  /** Set when state is rate_limited/quota_exhausted and the provider gave a reset hint. */
  retryAfterMs?: number
  checkedAt: string
}

/**
 * Task-shape hints the caller (Caye Direct route) supplies so Auto can make
 * a deterministic routing decision without an extra LLM call. All optional —
 * Auto degrades to general_reasoning + tool_use when nothing is known.
 */
export interface RouterTaskHints {
  isCodingOrRepoTask?: boolean
  needsLongContext?: boolean
  needsVision?: boolean
  needsToolUse?: boolean
  needsSessionContinuity?: boolean
  /** Founder explicitly asked for the strongest available reasoning, cost aside. */
  preferStrongest?: boolean
}

export interface FounderRouterContext {
  /** Supabase auth.users.id, already verified by requireFounder() at the route boundary. */
  founderUserId: string
  /** Caye Direct thread this invocation belongs to — for observability only. */
  threadId: string
  workspaceId?: string | null
}

export interface ModelInvokeRequest {
  ctx: FounderRouterContext
  /** Caye's own canonical conversation turns — the router never trusts a backend's own session memory. */
  messages: CanonicalMessage[]
  system: string
  hints?: RouterTaskHints
  maxOutputTokens?: number
}

export type CanonicalRole = 'user' | 'assistant'

export interface CanonicalMessage {
  role: CanonicalRole
  text: string
}

export interface ModelInvokeResult {
  backend: BackendId
  /** Provider model id if known/exposed (e.g. 'claude-sonnet-4-6'); undefined if the backend doesn't expose one. */
  model?: string
  text: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
  latencyMs: number
}

export type FallbackReasonCode =
  | 'quota_exhausted'
  | 'rate_limited'
  | 'auth_required'
  | 'transient_provider_failure'
  | 'client_unavailable'
  | 'capability_unsupported'
  | 'unhealthy'

export type NoFallbackReasonCode =
  | 'side_effect_may_have_occurred'
  | 'authorization_failure'
  | 'malformed_request'

/**
 * What classify() returns for a raw invocation error. `fallback: true` means
 * the router may retry the same turn against the next backend in the chain.
 * `fallback: false` means the router must surface the error and stop —
 * see error-classification.ts for the reasoning per case.
 */
export type ClassifiedError =
  | { fallback: true; reason: FallbackReasonCode; retryAfterMs?: number }
  | { fallback: false; reason: NoFallbackReasonCode }

export interface ModelBackend {
  id: BackendId
  provider: 'anthropic' | 'openai'
  authMode: 'subscription_cli' | 'api_key'
  capabilities: readonly Capability[]
  /** Cheap — must never spend a model prompt. See health.ts. */
  checkHealth(): Promise<BackendHealth>
  invoke(req: ModelInvokeRequest, signal: AbortSignal): Promise<ModelInvokeResult>
}

export interface RouterDecision {
  requestedMode: RequestedMode
  /** Ordered list the router will try, first to last. */
  chain: BackendId[]
  /** Which entry in `chain` actually served the request, once known. */
  selected?: BackendId
  fallbacksTried: { backend: BackendId; reason: FallbackReasonCode }[]
}
