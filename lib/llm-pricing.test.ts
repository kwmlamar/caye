import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { costForModel, pricingKeyFor } from './llm-pricing'

describe('pricing key resolution', () => {
  it('matches an exact alias', () => {
    expect(pricingKeyFor('gpt-5-mini')).toBe('gpt-5-mini')
    expect(pricingKeyFor('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  // Providers echo a dated snapshot rather than the alias requested. Production
  // llm_call_log contains only 'gpt-5-mini-2025-08-07', so exact-match pricing
  // reported $0 for every OpenAI call.
  it('resolves an OpenAI dated snapshot back to its alias', () => {
    expect(pricingKeyFor('gpt-5-mini-2025-08-07')).toBe('gpt-5-mini')
    expect(pricingKeyFor('gpt-5-2025-08-07')).toBe('gpt-5')
  })

  it('prefers an explicitly priced dated id over stripping it', () => {
    expect(pricingKeyFor('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
  })

  it('returns null for a genuinely unknown model rather than guessing a price', () => {
    expect(pricingKeyFor('some-unreleased-model')).toBeNull()
    expect(pricingKeyFor('mistral-large-2025-01-01')).toBeNull()
  })
})

describe('costForModel', () => {
  it('prices a dated snapshot identically to its alias', () => {
    const alias = costForModel('gpt-5-mini', 1_000_000, 1_000_000, 0, 0)
    const dated = costForModel('gpt-5-mini-2025-08-07', 1_000_000, 1_000_000, 0, 0)
    expect(dated).toBe(alias)
    expect(dated).toBeCloseTo(0.25 + 2, 9)
  })

  it('prices the real production research run instead of reporting zero', () => {
    // 13,555 input / 2,320 output tokens, gpt-5-mini-2025-08-07.
    const cost = costForModel('gpt-5-mini-2025-08-07', 13_555, 2_320, 0, 0)
    expect(cost).toBeGreaterThan(0)
    expect(cost).toBeCloseTo(13_555 * 0.25 / 1e6 + 2_320 * 2 / 1e6, 9)
  })

  it('still returns 0 for an unknown model rather than inventing a number', () => {
    expect(costForModel('unknown-model', 1000, 1000, 0, 0)).toBe(0)
  })
})
