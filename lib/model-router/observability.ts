import 'server-only'
import type { BackendId, FallbackReasonCode, RequestedMode } from './types'

/**
 * Structured log shape for every Caye Direct reasoning invocation
 * (brief section 15). Deliberately flat/JSON-serializable so it can go
 * straight to a Supabase table later (mirrors llm_call_log's shape) without
 * redesign. No ML/learning on this data yet (section 16) — it exists so a
 * later pass can ask "which backend wins by task type" from real numbers
 * instead of guesses.
 *
 * Never put a raw error object, token, or credential in here — use
 * `redactSecret` on anything that touched an auth header, OAuth token, or
 * API key before it reaches this shape.
 */
export interface RouterInvocationLog {
  requestedMode: RequestedMode
  selectedBackend?: BackendId
  model?: string
  fallbackSequence: { backend: BackendId; reason: FallbackReasonCode }[]
  latencyMs: number
  success: boolean
  /** Present only on failure — a safe, pre-redacted summary, never the raw error. */
  failureSummary?: string
  inputTokens?: number
  outputTokens?: number
  /** USD, only populated for API-billed backends where cost is computable from llm-pricing.ts. */
  apiCostUsd?: number
  threadId: string
  founderUserId: string
  loggedAt: string
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[a-zA-Z0-9_-]+/g, // Anthropic API keys and OAuth tokens (sk-ant-api..., sk-ant-oat01-...)
  /sk-[a-zA-Z0-9_-]{20,}/g, // OpenAI-style API keys
  /Bearer\s+[a-zA-Z0-9._-]+/gi,
  /"?access_token"?\s*[:=]\s*"?[a-zA-Z0-9._-]{10,}"?/gi,
]

/** Strips anything credential-shaped out of a string before it's allowed near a log line. */
export function redactSecrets(input: string): string {
  let out = input
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[redacted]')
  }
  return out
}

export function buildInvocationLog(params: {
  requestedMode: RequestedMode
  selectedBackend?: BackendId
  model?: string
  fallbackSequence: { backend: BackendId; reason: FallbackReasonCode }[]
  latencyMs: number
  success: boolean
  failureSummary?: string
  inputTokens?: number
  outputTokens?: number
  apiCostUsd?: number
  threadId: string
  founderUserId: string
}): RouterInvocationLog {
  return {
    ...params,
    failureSummary: params.failureSummary ? redactSecrets(params.failureSummary) : undefined,
    loggedAt: new Date().toISOString(),
  }
}
