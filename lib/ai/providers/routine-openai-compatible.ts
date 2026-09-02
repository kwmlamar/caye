import 'server-only'

/** Configuration for the optional bounded routine-model adapter. */
export interface RoutineInferenceConfig {
  enabled: boolean
  baseUrl?: string
  apiKey?: string
  model?: string
  timeoutMs: number
}

export type RoutineAttempt = { ok: true; content: string } | { ok: false; reason: RoutineFailureReason }
export type RoutineFailureReason = 'routine_provider_error' | 'routine_transport_error' | 'routine_timeout' | 'routine_malformed_output' | 'routine_empty_output'

const DEFAULT_TIMEOUT_MS = 15_000

/** Provider configuration belongs at the adapter boundary, never a feature. */
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

export async function runRoutineOpenAiCompatible(
  input: { system?: string; messages: readonly { role: 'user' | 'assistant'; content: string }[]; maxOutputTokens?: number },
  config: RoutineInferenceConfig,
): Promise<RoutineAttempt> {
  if (!isConfigured(config)) return { ok: false, reason: 'routine_provider_error' }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, config.timeoutMs)
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        ...(input.system ? { messages: [{ role: 'system', content: input.system }, ...input.messages] } : { messages: input.messages }),
        ...(input.maxOutputTokens ? { max_tokens: input.maxOutputTokens } : {}),
      }),
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, reason: 'routine_provider_error' }
    let json: unknown
    try { json = await response.json() } catch { return { ok: false, reason: 'routine_malformed_output' } }
    const content = extractContent(json)
    return content === undefined ? { ok: false, reason: 'routine_malformed_output' }
      : content.trim() ? { ok: true, content } : { ok: false, reason: 'routine_empty_output' }
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
    return url.protocol === 'http:' || url.protocol === 'https:' ? value.replace(/\/+$/, '') : undefined
  } catch { return undefined }
}

function extractContent(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content
  return typeof content === 'string' ? content : undefined
}
