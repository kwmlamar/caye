import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { createResearchProviderSession, NoResearchProviderError } from './router'
import { RESEARCH_SOURCE_FAILURE } from './source-fetch'
import type { ResearchCapability, ResearchProviderAdapter, ResearchProviderId } from './types'

const FULL_CAPABILITIES: ResearchCapability[] = [
  'web_search',
  'source_citations',
  'durable_source_fetch',
  'structured_output',
  'long_context',
]

/** Anthropic's real HTTP 400 account-exhaustion payload, verbatim from production. */
function anthropicCreditError(): Error {
  const error = new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CebDtrB4C3UuAtj4hjmqU"}')
  return Object.assign(error, { httpStatus: 400 })
}

function httpError(status: number, message = 'boom'): Error {
  return Object.assign(new Error(message), { httpStatus: status })
}

interface StubOptions {
  capabilities?: ResearchCapability[]
  usable?: boolean
  searchImpl?: () => Promise<Array<{ url: string; title?: string }>>
  fetchImpl?: (result: { url: string }) => Promise<any>
  completeImpl?: () => Promise<{ text: string; usage?: any; truncated?: boolean }>
}

function stubProvider(id: ResearchProviderId, model: string, options: StubOptions = {}) {
  const calls = { search: 0, fetch: 0, complete: 0, health: 0 }
  const adapter: ResearchProviderAdapter = {
    id,
    model,
    name: `${id}:${model}`,
    capabilities: options.capabilities ?? FULL_CAPABILITIES,
    async checkHealth() {
      calls.health += 1
      return { usable: options.usable ?? true }
    },
    async search() {
      calls.search += 1
      if (options.searchImpl) return options.searchImpl()
      return [{ url: 'https://example.gov/a', title: 'A' }]
    },
    async fetch(result) {
      calls.fetch += 1
      if (options.fetchImpl) return options.fetchImpl(result)
      return { ...result, content: 'durable text', fetchedAt: '2026-08-31T00:00:00Z' }
    },
    async complete() {
      calls.complete += 1
      if (options.completeImpl) return options.completeImpl()
      return {
        text: JSON.stringify({ claims: [{ statement: 'A finding.', claimType: 'finding', confidence: 0.7, sourceIds: ['S1'] }], brief: 'Understanding.' }),
        usage: { model, inputTokens: 100, outputTokens: 50 },
      }
    },
  }
  return { adapter, calls }
}

const SOURCES = [{ id: 'durable-source-uuid', source: { url: 'https://example.gov/a', content: 'durable text', fetchedAt: '2026-08-31T00:00:00Z', quality: 'official' as const } }]

const noSleep = async () => {}

describe('research provider routing', () => {
  it('selects OpenAI as the preferred provider by default, with no env configuration', async () => {
    const openai = stubProvider('openai', 'gpt-5')
    const anthropic = stubProvider('anthropic', 'claude-sonnet-5')

    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: { openai: () => openai.adapter, anthropic: () => anthropic.adapter },
      sleep: noSleep,
    })

    expect(session.preferred).toBe('openai')
    expect(session.chain[0]).toBe('openai')

    const binding = session.beginRun()
    await binding.provider.search('question')

    expect(openai.calls.search).toBe(1)
    expect(anthropic.calls.search).toBe(0)
    expect(binding.provider.name).toBe('openai:gpt-5')
  })

  it('produces canonical normalized research output through the shared synthesis contract', async () => {
    const openai = stubProvider('openai', 'gpt-5')
    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: { openai: () => openai.adapter },
      sleep: noSleep,
    })
    const binding = session.beginRun()

    const result = await binding.synthesize({ question: 'q', sources: SOURCES as any })

    // Alias S1 is mapped back to the durable source id — the provider never sees
    // or controls real source identifiers.
    expect(result.claims).toEqual([{
      statement: 'A finding.',
      claimType: 'finding',
      confidence: 0.7,
      sourceQuality: 'official',
      sourceIds: ['durable-source-uuid'],
    }])
    expect(result.brief).toBe('Understanding.')
  })

  it('falls back to Anthropic when OpenAI fails, and records the trail in provenance', async () => {
    const openai = stubProvider('openai', 'gpt-5', {
      searchImpl: async () => { throw httpError(503, 'upstream unavailable') },
    })
    const anthropic = stubProvider('anthropic', 'claude-sonnet-5')

    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: { openai: () => openai.adapter, anthropic: () => anthropic.adapter },
      sleep: noSleep,
    })
    const binding = session.beginRun()

    const results = await binding.provider.search('question')
    expect(results).toEqual([{ url: 'https://example.gov/a', title: 'A' }])

    const provenance = binding.provenance()
    expect(provenance.preferred).toBe('openai')
    expect(provenance.served).toEqual(['anthropic:claude-sonnet-5'])
    expect(provenance.fallbacks).toContainEqual(
      expect.objectContaining({ provider: 'openai', reason: 'transient_provider_failure', operation: 'search' }),
    )
    // A fallback must never be laundered into looking provider-independent.
    expect(binding.provider.name).toBe('anthropic:claude-sonnet-5')
  })

  it('retries a transient failure on the same provider before moving on', async () => {
    let attempts = 0
    const openai = stubProvider('openai', 'gpt-5', {
      searchImpl: async () => {
        attempts += 1
        if (attempts === 1) throw httpError(500, 'transient')
        return [{ url: 'https://example.gov/b', title: 'B' }]
      },
    })
    const anthropic = stubProvider('anthropic', 'claude-sonnet-5')

    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: { openai: () => openai.adapter, anthropic: () => anthropic.adapter },
      sleep: noSleep,
    })
    const binding = session.beginRun()

    expect(await binding.provider.search('q')).toEqual([{ url: 'https://example.gov/b', title: 'B' }])
    expect(attempts).toBe(2)
    expect(anthropic.calls.search).toBe(0)
  })

  it('treats Anthropic insufficient credit as non-retryable for that provider and stops re-dialling it for the whole cycle', async () => {
    const openai = stubProvider('openai', 'gpt-5', {
      searchImpl: async () => { throw httpError(500, 'transient') },
      fetchImpl: async () => { throw httpError(500, 'transient') },
      completeImpl: async () => { throw httpError(500, 'transient') },
    })
    const anthropic = stubProvider('anthropic', 'claude-sonnet-5', {
      searchImpl: async () => { throw anthropicCreditError() },
      fetchImpl: async () => { throw anthropicCreditError() },
      completeImpl: async () => { throw anthropicCreditError() },
    })

    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: { openai: () => openai.adapter, anthropic: () => anthropic.adapter },
      sleep: noSleep,
    })

    // A desk cycle runs many questions against one session.
    for (let question = 0; question < 5; question += 1) {
      const binding = session.beginRun()
      await expect(binding.provider.search('q')).rejects.toBeInstanceOf(NoResearchProviderError)
    }

    // Exactly one doomed call to the exhausted account, not one per question.
    expect(anthropic.calls.search).toBe(1)
    // ...and no pointless retry of the billing error against the same provider.
    expect(anthropic.calls.health).toBe(1)
  })

  it('fails clearly when no provider is available, without corrupting the research cycle', async () => {
    const openai = stubProvider('openai', 'gpt-5', { usable: false })
    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: { openai: () => openai.adapter },
      sleep: noSleep,
    })
    const binding = session.beginRun()

    await expect(binding.provider.search('q')).rejects.toBeInstanceOf(NoResearchProviderError)
    await expect(binding.provider.search('q')).rejects.toThrow(/No research provider is currently available/)

    // The failure is explanatory, not silent: provenance still names what happened.
    const provenance = binding.provenance()
    expect(provenance.served).toEqual([])
    expect(provenance.fallbacks).toContainEqual(expect.objectContaining({ provider: 'openai', reason: 'auth_required' }))
    // No claims, no evidence, nothing invented.
    expect(provenance.usage.calls).toBe(0)
  })

  it('fails clearly when the only configured provider lacks a required research capability', async () => {
    const openrouter = stubProvider('openrouter', 'openai/gpt-5', {
      capabilities: ['durable_source_fetch', 'structured_output', 'long_context'],
    })
    const session = createResearchProviderSession({
      env: { CAYE_RESEARCH_PROVIDER: 'openrouter', CAYE_RESEARCH_FALLBACKS: '' } as unknown as NodeJS.ProcessEnv,
      factories: { openrouter: () => openrouter.adapter },
      sleep: noSleep,
    })

    expect(session.chain).toEqual([])
    const binding = session.beginRun()
    await expect(binding.provider.search('q')).rejects.toThrow(/No research provider is configured/)
    expect(openrouter.calls.search).toBe(0)
  })

  it('does not blame the provider for a dead source link', async () => {
    const sourceFailure = Object.assign(new Error('Research source fetch failed with HTTP 404'), {
      [RESEARCH_SOURCE_FAILURE]: true,
      httpStatus: 404,
    })
    const openai = stubProvider('openai', 'gpt-5', { fetchImpl: async () => { throw sourceFailure } })
    const anthropic = stubProvider('anthropic', 'claude-sonnet-5')

    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: { openai: () => openai.adapter, anthropic: () => anthropic.adapter },
      sleep: noSleep,
    })
    const binding = session.beginRun()

    // Surfaced to executeResearchRun, which already tolerates per-source failures.
    await expect(binding.provider.fetch({ url: 'https://example.gov/gone' })).rejects.toThrow(/404/)
    // Someone else's broken page must not retire a healthy provider.
    expect(anthropic.calls.fetch).toBe(0)
    await binding.provider.search('q')
    expect(openai.calls.search).toBe(1)
  })

  it('honors an explicit Anthropic preference so the existing Anthropic path still works when configured', async () => {
    const openai = stubProvider('openai', 'gpt-5')
    const anthropic = stubProvider('anthropic', 'claude-sonnet-5')

    const session = createResearchProviderSession({
      env: { CAYE_RESEARCH_PROVIDER: 'anthropic', CAYE_RESEARCH_FALLBACKS: 'openai' } as unknown as NodeJS.ProcessEnv,
      factories: { openai: () => openai.adapter, anthropic: () => anthropic.adapter },
      sleep: noSleep,
    })
    const binding = session.beginRun()

    await binding.provider.search('q')
    await binding.synthesize({ question: 'q', sources: SOURCES as any })

    expect(anthropic.calls.search).toBe(1)
    expect(anthropic.calls.complete).toBe(1)
    expect(openai.calls.search).toBe(0)
    expect(binding.provider.name).toBe('anthropic:claude-sonnet-5')
  })

  it('records provider usage and cost for the serving model', async () => {
    const openai = stubProvider('openai', 'gpt-5')
    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: { openai: () => openai.adapter },
      sleep: noSleep,
    })
    const binding = session.beginRun()

    await binding.synthesize({ question: 'q', sources: SOURCES as any })
    const { usage } = binding.provenance()

    expect(usage.calls).toBe(1)
    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBe(50)
    // gpt-5: 100 input @ $1.25/M + 50 output @ $10/M.
    expect(usage.costUsd).toBeCloseTo(100 * 1.25 / 1e6 + 50 * 10 / 1e6, 9)
  })

  it('routes deterministically — identical sessions pick the same provider every time', async () => {
    const build = () => {
      const openai = stubProvider('openai', 'gpt-5')
      const anthropic = stubProvider('anthropic', 'claude-sonnet-5')
      return { openai, anthropic, session: createResearchProviderSession({
        env: {} as unknown as NodeJS.ProcessEnv,
        factories: { openai: () => openai.adapter, anthropic: () => anthropic.adapter },
        sleep: noSleep,
      }) }
    }

    for (let i = 0; i < 10; i += 1) {
      const { session, anthropic } = build()
      const binding = session.beginRun()
      await binding.provider.search('q')
      expect(binding.provider.name).toBe('openai:gpt-5')
      expect(anthropic.calls.search).toBe(0)
    }
  })
})

describe('provider output cannot bypass evidence validation', () => {
  it('rejects a claim citing a source alias that was never observed by this run', async () => {
    const openai = stubProvider('openai', 'gpt-5', {
      completeImpl: async () => ({
        text: JSON.stringify({ claims: [{ statement: 'Smuggled.', sourceIds: ['S9'] }], brief: 'b' }),
      }),
    })
    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: { openai: () => openai.adapter },
      sleep: noSleep,
    })
    const binding = session.beginRun()

    await expect(binding.synthesize({ question: 'q', sources: SOURCES as any }))
      .rejects.toThrow(/cited source IDs not present in this run|output contract/)
  })

  it('rejects an uncited claim no matter which provider produced it', async () => {
    for (const id of ['openai', 'anthropic'] as ResearchProviderId[]) {
      const provider = stubProvider(id, 'model-x', {
        completeImpl: async () => ({
          text: JSON.stringify({ claims: [{ statement: 'Trust me.', sourceIds: [] }], brief: 'b' }),
        }),
      })
      const session = createResearchProviderSession({
        env: { CAYE_RESEARCH_PROVIDER: id, CAYE_RESEARCH_FALLBACKS: '' } as unknown as NodeJS.ProcessEnv,
        factories: { [id]: () => provider.adapter },
        sleep: noSleep,
      })
      const binding = session.beginRun()

      await expect(binding.synthesize({ question: 'q', sources: SOURCES as any }))
        .rejects.toThrow(/lacks evidence|output contract/)
    }
  })

  it('rejects synthesis that returns no durable understanding', async () => {
    const openai = stubProvider('openai', 'gpt-5', {
      completeImpl: async () => ({ text: JSON.stringify({ claims: [{ statement: 'x', sourceIds: ['S1'] }] }) }),
    })
    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: { openai: () => openai.adapter },
      sleep: noSleep,
    })
    const binding = session.beginRun()

    await expect(binding.synthesize({ question: 'q', sources: SOURCES as any }))
      .rejects.toThrow(/no current understanding/)
  })

  it('refuses to synthesize with no durable source content, regardless of provider', async () => {
    const openai = stubProvider('openai', 'gpt-5')
    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: { openai: () => openai.adapter },
      sleep: noSleep,
    })
    const binding = session.beginRun()

    await expect(binding.synthesize({ question: 'q', sources: [] as any }))
      .rejects.toThrow(/requires durable source content/)
    expect(openai.calls.complete).toBe(0)
  })
})
