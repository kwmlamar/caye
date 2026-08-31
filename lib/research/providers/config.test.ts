import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  DEFAULT_RESEARCH_FALLBACKS,
  DEFAULT_RESEARCH_PROVIDER,
  parseProviderList,
  resolveResearchProviderPreference,
  supportsResearch,
} from './config'
import { REQUIRED_RESEARCH_CAPABILITIES } from './types'

const env = (values: Record<string, string | undefined>) => values as NodeJS.ProcessEnv

describe('research provider configuration', () => {
  it('defaults to OpenAI preferred with Anthropic and OpenRouter as fallbacks, with no env set', () => {
    const preference = resolveResearchProviderPreference(env({}))
    expect(preference.preferred).toBe('openai')
    expect(preference.chain).toEqual(['openai', 'anthropic', 'openrouter'])
    expect(DEFAULT_RESEARCH_PROVIDER).toBe('openai')
    expect(DEFAULT_RESEARCH_FALLBACKS).toEqual(['anthropic', 'openrouter'])
  })

  it('honors CAYE_RESEARCH_PROVIDER and CAYE_RESEARCH_FALLBACKS', () => {
    const preference = resolveResearchProviderPreference(env({
      CAYE_RESEARCH_PROVIDER: 'anthropic',
      CAYE_RESEARCH_FALLBACKS: 'openai,openrouter',
    }))
    expect(preference.preferred).toBe('anthropic')
    expect(preference.chain).toEqual(['anthropic', 'openai', 'openrouter'])
  })

  it('never lists the preferred provider twice', () => {
    const preference = resolveResearchProviderPreference(env({
      CAYE_RESEARCH_PROVIDER: 'openai',
      CAYE_RESEARCH_FALLBACKS: 'openai,anthropic,anthropic',
    }))
    expect(preference.chain).toEqual(['openai', 'anthropic'])
  })

  it('supports pinning to a single provider with no fallback', () => {
    const preference = resolveResearchProviderPreference(env({
      CAYE_RESEARCH_PROVIDER: 'anthropic',
      CAYE_RESEARCH_FALLBACKS: '',
    }))
    expect(preference.chain).toEqual(['anthropic'])
  })

  it('falls back to the coded default and reports an unrecognized provider instead of silently dropping it', () => {
    const preference = resolveResearchProviderPreference(env({
      CAYE_RESEARCH_PROVIDER: 'mistral',
      CAYE_RESEARCH_FALLBACKS: 'anthropic,cohere',
    }))
    expect(preference.preferred).toBe('openai')
    expect(preference.chain).toEqual(['openai', 'anthropic'])
    expect(preference.ignored).toEqual(['mistral', 'cohere'])
  })

  it('is case- and whitespace-insensitive', () => {
    const preference = resolveResearchProviderPreference(env({
      CAYE_RESEARCH_PROVIDER: '  Anthropic ',
      CAYE_RESEARCH_FALLBACKS: ' OpenAI , openrouter ',
    }))
    expect(preference.chain).toEqual(['anthropic', 'openai', 'openrouter'])
  })

  it('parses provider lists without inventing entries', () => {
    expect(parseProviderList(undefined)).toEqual([])
    expect(parseProviderList('')).toEqual([])
    expect(parseProviderList(',,')).toEqual([])
    expect(parseProviderList('openai,,anthropic')).toEqual(['openai', 'anthropic'])
  })
})

describe('research capability contract', () => {
  const adapter = (capabilities: readonly string[]) => ({ capabilities } as any)

  it('requires web search, citations, durable fetch and structured output', () => {
    expect([...REQUIRED_RESEARCH_CAPABILITIES].sort()).toEqual(
      ['durable_source_fetch', 'source_citations', 'structured_output', 'web_search'],
    )
  })

  it('accepts a provider declaring every required capability', () => {
    expect(supportsResearch(adapter([...REQUIRED_RESEARCH_CAPABILITIES]))).toBe(true)
  })

  it('rejects a provider that cannot discover sources — pretrained recall is not research', () => {
    expect(supportsResearch(adapter(['source_citations', 'durable_source_fetch', 'structured_output']))).toBe(false)
  })

  it('rejects a provider that cannot cite what it read', () => {
    expect(supportsResearch(adapter(['web_search', 'durable_source_fetch', 'structured_output']))).toBe(false)
  })
})
