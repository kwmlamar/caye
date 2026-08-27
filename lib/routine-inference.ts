import 'server-only'

export type InferenceTier = 'frontier' | 'routine'

export type RoutineFallbackReason =
  | 'routine_not_configured'
  | 'routine_provider_error'
  | 'routine_transport_error'
  | 'routine_timeout'
  | 'routine_malformed_output'
  | 'routine_empty_output'
  | 'routine_escalated'

export interface RoutineInferenceConfig {
  enabled: boolean
  baseUrl?: string
  apiKey?: string
  model?: string
  timeoutMs: number
}

export interface RoutineMessage {
  role: 'user' | 'assistant'
  content: string
}

export type RoutineParseResult<T> =
  | { kind: 'output'; value: T }
  | { kind: 'escalate' }

export interface RoutineInferenceMetadata {
  requestedTier: InferenceTier
  actualTier: InferenceTier
  provider: 'frontier' | 'openai_compatible'
  model?: string
  fallbackOccurred: boolean
  fallbackReason?: RoutineFallbackReason
  latencyMs: number
}

export interface RunInferenceOptions<T> {
  /** Routine use is opt-in at each call site. Frontier is always the default. */
  tier?: InferenceTier
  /** The existing authoritative inference path. It is never replaced by this module. */
  frontier: () => Promise<T>
  /** Required only when the caller explicitly opts into routine inference. */
  routine?: {
    system?: string
    messages: readonly RoutineMessage[]
    maxOutputTokens?: number
    /**
     * Converts the routine provider's response into a typed result or an
     * explicit structural escalation. Throwing marks output malformed.
     */
    parse: (content: string) => RoutineParseResult<T>
  }
  /** Set false only for callers that intentionally handle routine failure themselves. */
  fallbackToFrontier?: boolean
  config?: RoutineInferenceConfig
  /** Metadata only: never receives prompt content, provider response bodies, or secrets. */
  onMetadata?: (metadata: RoutineInferenceMetadata) => void
}

const DEFAULT_TIMEOUT_MS = 15_000

/** Reads only explicit Caye-scoped configuration; absent configuration preserves frontier behavior. */
export function readRoutineInferenceConfig(env: Partial<NodeJS.ProcessEnv> = process.env): RoutineInferenceConfig {
  const timeout = Number(env.CAYE_ROUTINE_MODEL_TIMEOUT_MS)
  return {
    enabled: env.CAYE_ROUTINE_MODEL_ENABLED === 'true',
    baseUrl: cleanBaseUrl(env.CAYE_ROUTINE_MODEL_BASE_URL),
    apiKey: env.CAYE_ROUTINE_MODEL_API_KEY,
    model: env.CAYE_ROUTINE_MODEL,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  }
}

/**
 * A deliberately narrow OpenAI-compatible Chat Completions boundary. It owns
 * only bounded cognition: callers execute any consequence after this returns.
 */
export async function runInference<T>(options: RunInferenceOptions<T>): Promise<T> {
  const startedAt = Date.now()
  const requestedTier = options.tier ?? 'frontier'
  const config = options.config ?? readRoutineInferenceConfig()
  let fallbackReason: RoutineFallbackReason | undefined

  if (requestedTier === 'routine') {
    if (!options.routine || !isConfigured(config)) {
      fallbackReason = 'routine_not_configured'
    } else {
      const attempted = await attemptRoutine(options.routine, config)
      if (attempted.ok) {
        try {
          const parsed = options.routine.parse(attempted.content)
          if (parsed.kind === 'output') {
            options.onMetadata?.({
              requestedTier,
              actualTier: 'routine',
              provider: 'openai_compatible',
              model: config.model,
              fallbackOccurred: false,
              latencyMs: Date.now() - startedAt,
            })
            return parsed.value
          }
          fallbackReason = 'routine_escalated'
        } catch {
          fallbackReason = attempted.content.trim() ? 'routine_malformed_output' : 'routine_empty_output'
        }
      } else {
        fallbackReason = attempted.reason
      }
    }
  }

  if (requestedTier === 'routine' && options.fallbackToFrontier === false) {
    throw new RoutineInferenceUnavailableError(fallbackReason ?? 'routine_not_configured')
  }

  const result = await options.frontier()
  options.onMetadata?.({
    requestedTier,
    actualTier: 'frontier',
    provider: 'frontier',
    fallbackOccurred: Boolean(fallbackReason),
    fallbackReason,
    latencyMs: Date.now() - startedAt,
  })
  return result
}

export class RoutineInferenceUnavailableError extends Error {
  constructor(public readonly reason: RoutineFallbackReason) {
    super(`Routine inference unavailable: ${reason}`)
    this.name = 'RoutineInferenceUnavailableError'
  }
}

type RoutineAttempt = { ok: true; content: string } | { ok: false; reason: RoutineFallbackReason }

async function attemptRoutine(
  routine: NonNullable<RunInferenceOptions<unknown>['routine']>,
  config: RoutineInferenceConfig
): Promise<RoutineAttempt> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, config.timeoutMs)

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        ...(routine.system ? { messages: [{ role: 'system', content: routine.system }, ...routine.messages] } : { messages: routine.messages }),
        ...(routine.maxOutputTokens ? { max_tokens: routine.maxOutputTokens } : {}),
      }),
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, reason: 'routine_provider_error' }

    let json: unknown
    try {
      json = await response.json()
    } catch {
      return { ok: false, reason: 'routine_malformed_output' }
    }
    const content = extractContent(json)
    return content === undefined
      ? { ok: false, reason: 'routine_malformed_output' }
      : content.trim()
        ? { ok: true, content }
        : { ok: false, reason: 'routine_empty_output' }
  } catch {
    return { ok: false, reason: timedOut ? 'routine_timeout' : 'routine_transport_error' }
  } finally {
    clearTimeout(timer)
  }
}

function isConfigured(config: RoutineInferenceConfig): config is RoutineInferenceConfig & Required<Pick<RoutineInferenceConfig, 'baseUrl' | 'apiKey' | 'model'>> {
  return config.enabled && Boolean(config.baseUrl && config.apiKey && config.model)
}

function cleanBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return value.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

function extractContent(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content
  return typeof content === 'string' ? content : undefined
}
