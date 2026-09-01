import 'server-only'
import { MODELS } from './models'
import { TASK_ROUTES } from './routes'
import { allProviderAdapters } from './providers'
import { AI_TASKS, type AIProviderId, type AITask } from './types'

/**
 * "Does Caye have a usable AI route at all?"
 *
 * Deliberately NOT a throw at module load. Caye runs on Vercel: a module-scope
 * throw takes down every route in the bundle, including the billing, webhook
 * and health endpoints that are the only way to diagnose and fix a missing
 * key. A config problem that the gateway can route around must not become an
 * outage — and one it genuinely cannot route around already surfaces as a
 * loud, specific NoAIProviderAvailableError on the request that needed it.
 *
 * So this is a *check*, exposed on the founder health surface and the
 * provider admin API, plus a test that fails CI if the route table ever
 * grows a task that only one vendor can serve.
 */
export interface AiConfigValidation {
  valid: boolean
  configuredProviders: AIProviderId[]
  missingProviders: AIProviderId[]
  /** Tasks with no eligible provider at all. Non-empty means Caye is broken. */
  unroutableTasks: AITask[]
  /** Tasks currently down to a single configured provider — works, but no failover. */
  singleProviderTasks: AITask[]
  message: string
}

export function validateAiConfiguration(): AiConfigValidation {
  const configured = allProviderAdapters().filter((a) => a.hasCredentials()).map((a) => a.id)
  const missing = allProviderAdapters().filter((a) => !a.hasCredentials()).map((a) => a.id)

  const unroutable: AITask[] = []
  const singleProvider: AITask[] = []

  for (const task of AI_TASKS) {
    const providers = new Set(
      TASK_ROUTES[task].map((key) => MODELS[key].provider).filter((p) => configured.includes(p))
    )
    if (providers.size === 0) unroutable.push(task)
    else if (providers.size === 1) singleProvider.push(task)
  }

  const valid = unroutable.length === 0

  return {
    valid,
    configuredProviders: configured,
    missingProviders: missing,
    unroutableTasks: unroutable,
    singleProviderTasks: singleProvider,
    message: !valid
      ? 'No AI provider is configured. Set at least one of ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY.'
      : singleProvider.length > 0
        ? `Caye is running on a single provider (${configured.join(', ')}). Requests will work, but there is no failover if it becomes unavailable.`
        : `Failover available across ${configured.join(', ')}.`,
  }
}
