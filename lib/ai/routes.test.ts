import { describe, it, expect, vi } from 'vitest'
vi.mock('server-only', () => ({}))

const { TASK_ROUTES, routeForTask, inferTask, applyProviderPriority, providerPriorityOverride } = await import('./routes')
const { MODELS } = await import('./models')
const { AI_TASKS, AI_PROVIDER_IDS } = await import('./types')
const { requiredCapabilities, modelCanServe, estimateRequestTokens } = await import('./capabilities')

describe('route table', () => {
  it('gives every task a route', () => {
    for (const task of AI_TASKS) expect(TASK_ROUTES[task]?.length ?? 0).toBeGreaterThan(0)
  })

  it('gives every task a path to all three providers, so no task is single-vendor', () => {
    for (const task of AI_TASKS) {
      const providers = new Set(TASK_ROUTES[task].map((key) => MODELS[key].provider))
      expect([...providers].sort(), task).toEqual([...AI_PROVIDER_IDS].sort())
    }
  })

  it('never repeats a model within one route', () => {
    for (const task of AI_TASKS) {
      expect(new Set(TASK_ROUTES[task]).size, task).toBe(TASK_ROUTES[task].length)
    }
  })

  it('leads customer-facing generation with the strong tier', () => {
    for (const task of ['customer_response', 'operator_response', 'agent_planning', 'business_analysis'] as const) {
      expect(MODELS[TASK_ROUTES[task][0]].tier, task).toBe('strong')
    }
  })

  it('leads high-volume work with the cheap tier', () => {
    for (const task of ['classification', 'fact_extraction', 'summarization'] as const) {
      expect(MODELS[TASK_ROUTES[task][0]].tier, task).toBe('cheap')
    }
  })
})

describe('configuration overrides', () => {
  it('applies a per-task route override', () => {
    expect(routeForTask('classification', { CAYE_AI_ROUTE_CLASSIFICATION: 'openai_cheap,openrouter_cheap' } as never))
      .toEqual(['openai_cheap', 'openrouter_cheap'])
  })

  it('ignores an override that names no known model rather than crashing a live request', () => {
    expect(routeForTask('classification', { CAYE_AI_ROUTE_CLASSIFICATION: 'nonsense' } as never))
      .toEqual(TASK_ROUTES.classification)
  })

  it('reorders providers without inventing routes', () => {
    const reordered = applyProviderPriority(TASK_ROUTES.customer_response, ['openai', 'openrouter', 'anthropic'])
    expect(reordered.map((k) => MODELS[k].provider)).toEqual(['openai', 'openrouter', 'anthropic'])
    expect([...reordered].sort()).toEqual([...TASK_ROUTES.customer_response].sort())
  })

  it('leaves the route untouched when there is no priority', () => {
    expect(applyProviderPriority(TASK_ROUTES.research, null)).toEqual(TASK_ROUTES.research)
  })

  it('parses a provider order from the environment', () => {
    expect(providerPriorityOverride({ CAYE_AI_PROVIDER_ORDER: 'openai, anthropic' } as never)).toEqual(['openai', 'anthropic'])
    expect(providerPriorityOverride({ CAYE_AI_PROVIDER_ORDER: 'garbage' } as never)).toBeNull()
    expect(providerPriorityOverride({} as never)).toBeNull()
  })
})

describe('task inference for untagged legacy call sites', () => {
  it('routes a front-desk source to customer_response', () => {
    expect(inferTask('lib/caye-reply.ts:generateCayeAutoReply')).toBe('customer_response')
  })
  it('routes the tool loop to agent_planning', () => {
    expect(inferTask('lib/caye-agent/execute.ts:runToolLoop')).toBe('agent_planning')
  })
  it('prefers an explicit task over the source hint', () => {
    expect(inferTask('lib/caye-reply.ts:generateCayeAutoReply', 'classification')).toBe('classification')
  })
  it('falls back to `other` for an unrecognised source', () => {
    expect(inferTask('lib/something-new.ts:doThing')).toBe('other')
  })
})

describe('capability requirements are read off the request', () => {
  const base = { model: 'm', max_tokens: 100, messages: [{ role: 'user' as const, content: 'hi' }] }

  it('detects tool use', () => {
    expect(requiredCapabilities({ ...base, tools: [{ name: 't', input_schema: { type: 'object' } }] } as never))
      .toContain('tool_use')
  })

  it('detects a vision request even when the caller never declared one', () => {
    const withImage = {
      ...base,
      messages: [{ role: 'user' as const, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] }],
    }
    expect(requiredCapabilities(withImage as never)).toContain('vision')
  })

  it('detects an image nested inside a tool result', () => {
    const nested = {
      ...base,
      messages: [{ role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'image', source: {} }] }] }],
    }
    expect(requiredCapabilities(nested as never)).toContain('vision')
  })

  it('requires nothing special for a plain text request', () => {
    expect(requiredCapabilities(base as never)).toEqual([])
  })

  it('rejects a model whose context window cannot hold the request', () => {
    const huge = { ...base, messages: [{ role: 'user' as const, content: 'x'.repeat(2_000_000) }] }
    expect(modelCanServe(MODELS.openrouter_cheap, huge as never)).toEqual({ ok: false, missing: 'long_context' })
    expect(estimateRequestTokens(huge as never)).toBeGreaterThan(400_000)
  })

  it('accepts a model that can hold the request', () => {
    expect(modelCanServe(MODELS.anthropic_strong, base as never)).toEqual({ ok: true })
  })
})
