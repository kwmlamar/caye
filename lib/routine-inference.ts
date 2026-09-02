import 'server-only'
import {
  readRoutineInferenceConfig,
  type RoutineInferenceConfig,
} from '@/lib/ai/providers/routine-openai-compatible'
import { generateRoutine } from '@/lib/ai/routine'

export { readRoutineInferenceConfig, type RoutineInferenceConfig } from '@/lib/ai/providers/routine-openai-compatible'

export type InferenceTier = 'frontier' | 'routine'

export type RoutineFallbackReason =
  | 'routine_not_configured'
  | 'routine_provider_error'
  | 'routine_transport_error'
  | 'routine_timeout'
  | 'routine_malformed_output'
  | 'routine_empty_output'
  | 'routine_escalated'

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
  /** Model used by the frontier callback, when known, for safe routing telemetry. */
  frontierModel?: string
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
      const attempted = await generateRoutine(options.routine, config)
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
    model: options.frontierModel,
    fallbackOccurred: Boolean(fallbackReason),
    fallbackReason,
    latencyMs: Date.now() - startedAt,
  })
  return result
}

/**
 * Small structured server-log sink for a reviewed routine workload. This is
 * intentionally metadata-only: prompts, completions, response bodies, and
 * credentials never reach it.
 */
export function createRoutineInferenceLogger(workload: string): (metadata: RoutineInferenceMetadata) => void {
  return (metadata) => console.info('[routine-inference]', { workload, ...metadata })
}

export class RoutineInferenceUnavailableError extends Error {
  constructor(public readonly reason: RoutineFallbackReason) {
    super(`Routine inference unavailable: ${reason}`)
    this.name = 'RoutineInferenceUnavailableError'
  }
}

function isConfigured(config: RoutineInferenceConfig): config is RoutineInferenceConfig & Required<Pick<RoutineInferenceConfig, 'baseUrl' | 'apiKey' | 'model'>> {
  return config.enabled && Boolean(config.baseUrl && config.apiKey && config.model)
}
