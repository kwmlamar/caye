import 'server-only'

/**
 * Caye AI Gateway — the single entry point for every AI capability request.
 *
 *   const result = await ai.generate({
 *     params: { model: ..., max_tokens: ..., messages, tools },
 *     ctx: { source: 'lib/caye-reply.ts:replyLoop', task: 'customer_response', workspaceId },
 *   })
 *
 * `params.model` is advisory only — the gateway routes by `ctx.task` against
 * lib/ai/routes.ts and overrides it with the selected route's model. Callers
 * that still pass a model string are honoured for telemetry continuity but
 * cannot pin Caye to one vendor.
 *
 * Anthropic-shaped call sites use `loggedMessagesCreate` in
 * lib/llm-telemetry.ts, which is a thin facade over this same gateway.
 */
export { generate } from './gateway'
export * from './types'
export { MODELS, modelSpec, findModelByProviderId, type ModelKey, type ModelSpec } from './models'
export { TASK_ROUTES, routeForTask, inferTask, applyProviderPriority, providerPriorityOverride } from './routes'
export { classifyAIError, policyFor, FAILURE_POLICY, type FailurePolicy } from './errors'
export { requiredCapabilities, modelCanServe, estimateRequestTokens } from './capabilities'
export {
  loadProviderHealth,
  isCircuitOpen,
  recordProviderSuccess,
  recordProviderFailure,
  clearProviderCircuit,
  resetHealthCache,
  type ProviderHealth,
} from './health'
export {
  loadProviderSettings,
  setProviderEnabled,
  setProviderPriority,
  resetProviderSettingsCache,
  priorityOrder,
  type ProviderSetting,
} from './provider-settings'
export { providerAdapter, allProviderAdapters, setProviderAdapters } from './providers'
export { usageFromResponse } from './telemetry'
export { validateAiConfiguration, type AiConfigValidation } from './config-validation'

import { generate } from './gateway'

/** Namespaced alias so call sites read as `ai.generate(...)`. */
export const ai = { generate }
