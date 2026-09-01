import 'server-only'
import { MODELS, type ModelKey } from './models'
import { AI_TASKS, isAITask, type AIProviderId, type AITask } from './types'

/**
 * Deterministic task -> ordered route table.
 *
 * No LLM call is spent deciding which LLM answers. Each entry is tried in
 * order; a route is skipped (not failed) when the provider is disabled,
 * uncredentialed, circuit-open, or incapable of the request as written.
 *
 * Ordering policy, stated once so it can be argued with:
 *
 *  - Customer-visible generation and real reasoning lead with the strongest
 *    model, because a cheaper answer that reads wrong to a paying customer's
 *    guest costs more than the token delta.
 *  - Classification/extraction/summarisation lead with the cheap tier.
 *    These are high-volume and structurally constrained.
 *  - Every task ends on OpenRouter, which is the "both primary vendors are
 *    having a bad day" route, not a cost route.
 *  - `research` intentionally leads with OpenAI: continuous research is the
 *    single largest recurring spend line and lib/research already made this
 *    call (see lib/research/providers/config.ts). Kept identical so this
 *    migration does not silently re-price research.
 *
 * Tuning happens here or via CAYE_AI_ROUTE_<TASK>; never at a call site.
 */
export const TASK_ROUTES: Record<AITask, readonly ModelKey[]> = {
  customer_response: ['anthropic_strong', 'openai_strong', 'openrouter_strong'],
  operator_response: ['anthropic_strong', 'openai_strong', 'openrouter_strong'],
  agent_planning: ['anthropic_strong', 'openai_strong', 'openrouter_strong'],
  business_analysis: ['anthropic_strong', 'openai_strong', 'openrouter_strong'],
  opportunity_detection: ['anthropic_strong', 'openai_strong', 'openrouter_strong'],
  onboarding: ['anthropic_strong', 'openai_strong', 'openrouter_strong'],
  outreach: ['anthropic_strong', 'openai_strong', 'openrouter_strong'],
  other: ['anthropic_strong', 'openai_strong', 'openrouter_strong'],

  fact_extraction: ['anthropic_cheap', 'openai_cheap', 'anthropic_strong', 'openrouter_cheap'],
  classification: ['anthropic_cheap', 'openai_cheap', 'anthropic_strong', 'openrouter_cheap'],
  summarization: ['anthropic_cheap', 'openai_cheap', 'anthropic_strong', 'openrouter_cheap'],

  research: ['openai_strong', 'anthropic_strong', 'openrouter_strong'],
}

/**
 * Per-task override, e.g.
 *   CAYE_AI_ROUTE_CLASSIFICATION=openai_cheap,openrouter_cheap
 * Unknown keys are ignored rather than crashing a production request; an
 * override that resolves to nothing falls back to the compiled route.
 */
export function routeForTask(task: AITask, env: NodeJS.ProcessEnv = process.env): readonly ModelKey[] {
  const raw = env[`CAYE_AI_ROUTE_${task.toUpperCase()}`]
  if (!raw) return TASK_ROUTES[task]
  const parsed = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is ModelKey => entry in MODELS)
  return parsed.length > 0 ? parsed : TASK_ROUTES[task]
}

/**
 * Providers may be pinned globally for an incident ("everything on OpenAI
 * until Anthropic billing is fixed") without editing per-task routes:
 *   CAYE_AI_PROVIDER_ORDER=openai,anthropic,openrouter
 * This reorders, it never adds a route a task didn't have.
 */
export function providerPriorityOverride(env: NodeJS.ProcessEnv = process.env): AIProviderId[] | null {
  const raw = env.CAYE_AI_PROVIDER_ORDER
  if (!raw) return null
  const known: AIProviderId[] = ['anthropic', 'openai', 'openrouter']
  const parsed = raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e): e is AIProviderId => (known as string[]).includes(e))
  return parsed.length > 0 ? [...new Set(parsed)] : null
}

export function applyProviderPriority(route: readonly ModelKey[], order: AIProviderId[] | null): readonly ModelKey[] {
  if (!order) return route
  const rank = (key: ModelKey) => {
    const index = order.indexOf(MODELS[key].provider)
    return index === -1 ? order.length : index
  }
  // Stable sort: within a provider, the compiled route order is preserved.
  return [...route]
    .map((key, index) => ({ key, index }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.index - b.index)
    .map((entry) => entry.key)
}

/**
 * Best-effort task inference for call sites that have not been given an
 * explicit `task` yet. Keyed on the existing `source` tag convention
 * (`file/path.ts:function`) so spend history and routing agree.
 *
 * This is a migration aid, not the contract: an explicit `task` always wins.
 */
const SOURCE_TASK_HINTS: [RegExp, AITask][] = [
  [/caye-reply|frontdesk|front-desk|meta-reply|whatsapp\.ts/i, 'customer_response'],
  [/execute\.ts:runToolLoop|tool-loop|orchestrator/i, 'agent_planning'],
  [/business-fact|inbound-digest-extract|contact-profile|voice-profile|artifacts\/understand/i, 'fact_extraction'],
  [/intent|classify|forced-escalation|semantic-match/i, 'classification'],
  [/summarize|history-compaction|threads-summarize/i, 'summarization'],
  [/briefing|business-insights|catch-up-welcome|nudge/i, 'business_analysis'],
  [/discovery|opportunity/i, 'opportunity_detection'],
  [/research/i, 'research'],
  [/onboarding/i, 'onboarding'],
  [/outreach/i, 'outreach'],
  [/operator|admin-shell|caye-direct|founder/i, 'operator_response'],
]

export function inferTask(source: string | undefined, explicit?: AITask): AITask {
  if (isAITask(explicit)) return explicit
  if (!source) return 'other'
  for (const [pattern, task] of SOURCE_TASK_HINTS) {
    if (pattern.test(source)) return task
  }
  return 'other'
}

export { AI_TASKS }
