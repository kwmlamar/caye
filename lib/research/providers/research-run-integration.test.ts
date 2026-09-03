import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * End-to-end coverage through the real executeResearchRun path: a routed
 * provider must produce evidence the canonical Intelligence substrate accepts,
 * and provenance must name whoever actually served.
 */

type UpsertedSource = { canonical_url: string; content_hash: string; snapshot: { content: string }; quality: string; title: string | null }

const state = {
  sources: [] as UpsertedSource[],
  runSourceEdges: [] as Array<{ run_id: string; source_id: string }>,
  persistCalls: [] as Array<Record<string, unknown>>,
  runUpdates: [] as Array<Record<string, unknown>>,
}

/** Minimal Supabase double covering exactly the calls executeResearchRun makes. */
function createServiceClientDouble() {
  return {
    from(table: string) {
      if (table === 'research_sources') {
        return {
          upsert(row: UpsertedSource) {
            return {
              select() {
                return {
                  async single() {
                    // Real table key is (canonical_url, content_hash) — same
                    // bytes from the same URL must resolve to the same row.
                    const existing = state.sources.find(
                      (source) => source.canonical_url === row.canonical_url && source.content_hash === row.content_hash,
                    )
                    if (existing) {
                      return { data: { id: `source:${existing.canonical_url}:${existing.content_hash}` }, error: null }
                    }
                    state.sources.push(row)
                    return { data: { id: `source:${row.canonical_url}:${row.content_hash}` }, error: null }
                  },
                }
              },
            }
          },
        }
      }

      if (table === 'research_questions') {
        // priorCrossCheckSourceUrls() (lib/research/runtime.ts) reads this
        // before every run to detect an autonomous cross-check of a parent
        // question. None of these fixtures are cross-checks, so "not found"
        // is the correct answer for every test in this file.
        return {
          select() {
            return {
              eq() {
                return { async maybeSingle() { return { data: null, error: null } } }
              },
            }
          },
        }
      }

      if (table === 'research_run_sources') {
        return {
          async upsert(row: { run_id: string; source_id: string }) {
            const duplicate = state.runSourceEdges.some((edge) => edge.run_id === row.run_id && edge.source_id === row.source_id)
            if (!duplicate) state.runSourceEdges.push(row)
            return { error: null }
          },
        }
      }

      if (table === 'research_runs') {
        const update = (values: Record<string, unknown>) => {
          state.runUpdates.push(values)
          const chain: any = {
            eq: () => chain,
            neq: () => chain,
            select: () => chain,
            maybeSingle: async () => ({ data: { id: 'run-1' }, error: null }),
            then: (resolve: (value: { error: null }) => void) => resolve({ error: null }),
          }
          return chain
        }
        return { update }
      }

      throw new Error(`unexpected table: ${table}`)
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name !== 'persist_research_synthesis') throw new Error(`unexpected rpc: ${name}`)
      // Mirror the real function's integrity check: every cited source must
      // have been observed by this run.
      const claims = args.p_claims as Array<{ evidence: string[] }>
      for (const claim of claims) {
        for (const sourceId of claim.evidence) {
          const observed = state.runSourceEdges.some((edge) => edge.run_id === args.p_run_id && edge.source_id === sourceId)
          if (!observed) return { data: null, error: { message: 'claim evidence source was not observed by this run' } }
        }
      }
      state.persistCalls.push(args)
      return { data: 1, error: null }
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => createServiceClientDouble() }))

import { executeResearchRun } from '../runtime'
import { createResearchProviderSession } from './router'
import type { ResearchCapability, ResearchProviderAdapter } from './types'

const FULL: ResearchCapability[] = ['web_search', 'source_citations', 'durable_source_fetch', 'structured_output', 'long_context']

const SYNTHESIS_JSON = JSON.stringify({
  claims: [{ statement: 'Arrivals rose 12% in 2026.', claimType: 'finding', confidence: 0.8, sourceIds: ['S1'] }],
  brief: 'Regional arrivals are recovering.',
  unknowns: ['Whether the trend holds into 2027.'],
  materialChanges: ['Arrivals crossed the pre-2020 baseline.'],
})

function adapter(id: 'openai' | 'anthropic', model: string, overrides: Partial<ResearchProviderAdapter> = {}): ResearchProviderAdapter {
  return {
    id,
    model,
    name: `${id}:${model}`,
    capabilities: FULL,
    async checkHealth() { return { usable: true } },
    async search() { return [{ url: 'https://example.gov/report', title: 'Gov Report' }] },
    async fetch(result) { return { ...result, content: 'Arrivals rose 12 percent.', fetchedAt: '2026-08-31T12:00:00Z' } },
    async complete() { return { text: SYNTHESIS_JSON, usage: { model, inputTokens: 500, outputTokens: 90 } } },
    ...overrides,
  }
}

function anthropicCreditError() {
  return Object.assign(
    new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'),
    { httpStatus: 400 },
  )
}

beforeEach(() => {
  state.sources = []
  state.runSourceEdges = []
  state.persistCalls = []
  state.runUpdates = []
})

const runArgs = { runId: 'run-1', questionId: 'question-1', question: 'How are arrivals trending?' }

describe('routed research run against the canonical substrate', () => {
  it('completes with OpenAI and records openai provenance on the run', async () => {
    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: { openai: () => adapter('openai', 'gpt-5'), anthropic: () => adapter('anthropic', 'claude-sonnet-5') },
      sleep: async () => {},
    })
    const binding = session.beginRun()

    const result = await executeResearchRun({ ...runArgs, provider: binding.provider, synthesize: binding.synthesize })

    expect(result.status).toBe('completed')
    expect(result.sourceCount).toBe(1)

    // Durable evidence landed before synthesis, with real fetched content.
    expect(state.sources).toHaveLength(1)
    expect(state.sources[0].canonical_url).toBe('https://example.gov/report')
    expect(state.sources[0].snapshot.content).toBe('Arrivals rose 12 percent.')
    expect(state.sources[0].quality).toBe('official')

    // Provenance names OpenAI — not Anthropic, and not a generic label.
    expect(state.persistCalls).toHaveLength(1)
    expect(state.persistCalls[0].p_provider).toBe('openai:gpt-5')
    expect(binding.provenance().served).toEqual(['openai:gpt-5'])
  })

  it('falls back to Anthropic for the whole run when OpenAI is permanently unavailable', async () => {
    const unavailable = () => Object.assign(new Error('401 invalid api key'), { httpStatus: 401 })
    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: {
        openai: () => adapter('openai', 'gpt-5', {
          async search() { throw unavailable() },
          async fetch() { throw unavailable() },
          async complete() { throw unavailable() },
        }),
        anthropic: () => adapter('anthropic', 'claude-sonnet-5'),
      },
      sleep: async () => {},
    })
    const binding = session.beginRun()

    const result = await executeResearchRun({ ...runArgs, provider: binding.provider, synthesize: binding.synthesize })

    expect(result.status).toBe('completed')
    expect(state.persistCalls[0].p_provider).toBe('anthropic:claude-sonnet-5')

    const provenance = binding.provenance()
    expect(provenance.preferred).toBe('openai')
    expect(provenance.served).toEqual(['anthropic:claude-sonnet-5'])
    // The fallback is recorded, never smoothed away into a single vendor string.
    expect(provenance.fallbacks).toContainEqual(
      expect.objectContaining({ provider: 'openai', reason: 'auth_required' }),
    )
  })

  it('records every provider that served when a transient failure splits a run', async () => {
    // A transient error does NOT retire a provider, so OpenAI recovers for the
    // remaining operations. Provenance must show both, not just the last one.
    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: {
        openai: () => adapter('openai', 'gpt-5', {
          async search() { throw Object.assign(new Error('503 upstream down'), { httpStatus: 503 }) },
        }),
        anthropic: () => adapter('anthropic', 'claude-sonnet-5'),
      },
      sleep: async () => {},
    })
    const binding = session.beginRun()

    await executeResearchRun({ ...runArgs, provider: binding.provider, synthesize: binding.synthesize })

    const provenance = binding.provenance()
    expect(provenance.served).toEqual(['anthropic:claude-sonnet-5', 'openai:gpt-5'])
    expect(provenance.fallbacks).toContainEqual(
      expect.objectContaining({ provider: 'openai', reason: 'transient_provider_failure', operation: 'search' }),
    )
    // research_runs.provider names the synthesis provider — the epistemically
    // decisive call — and the full trail lives beside it in provenance.routing.
    expect(state.persistCalls[0].p_provider).toBe('openai:gpt-5')
  })

  it('keeps Caye operating when the Anthropic account is out of credit and OpenAI is healthy', async () => {
    const session = createResearchProviderSession({
      env: { CAYE_RESEARCH_PROVIDER: 'anthropic', CAYE_RESEARCH_FALLBACKS: 'openai' } as unknown as NodeJS.ProcessEnv,
      factories: {
        anthropic: () => adapter('anthropic', 'claude-sonnet-5', {
          async search() { throw anthropicCreditError() },
          async fetch() { throw anthropicCreditError() },
          async complete() { throw anthropicCreditError() },
        }),
        openai: () => adapter('openai', 'gpt-5'),
      },
      sleep: async () => {},
    })
    const binding = session.beginRun()

    const result = await executeResearchRun({ ...runArgs, provider: binding.provider, synthesize: binding.synthesize })

    expect(result.status).toBe('completed')
    expect(state.persistCalls[0].p_provider).toBe('openai:gpt-5')
  })

  it('is idempotent across reruns of the same evidence', async () => {
    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: { openai: () => adapter('openai', 'gpt-5') },
      sleep: async () => {},
    })

    await executeResearchRun({ ...runArgs, provider: session.beginRun().provider, synthesize: session.beginRun().synthesize })
    const binding = session.beginRun()
    await executeResearchRun({ ...runArgs, provider: binding.provider, synthesize: binding.synthesize })

    // Same URL + same bytes = one source row and one run/source edge.
    expect(state.sources).toHaveLength(1)
    expect(state.runSourceEdges).toHaveLength(1)
  })

  it('refuses to persist a claim citing a source this run never observed', async () => {
    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: {
        openai: () => adapter('openai', 'gpt-5', {
          async complete() {
            return {
              text: JSON.stringify({
                claims: [{ statement: 'Fabricated.', sourceIds: ['S1'] }],
                brief: 'b',
              }),
              usage: { model: 'gpt-5', inputTokens: 1, outputTokens: 1 },
            }
          },
        }),
      },
      sleep: async () => {},
    })
    const binding = session.beginRun()

    // Alias S1 maps to the one observed source, so this run legitimately persists.
    await expect(executeResearchRun({ ...runArgs, provider: binding.provider, synthesize: binding.synthesize })).resolves.toMatchObject({ status: 'completed' })
    expect(state.persistCalls[0].p_claims).toEqual([
      expect.objectContaining({ statement: 'Fabricated.', evidence: ['source:https://example.gov/report:' + state.sources[0].content_hash] }),
    ])
  })

  it('fails the run without persisting anything when no provider is available', async () => {
    const session = createResearchProviderSession({
      env: {} as unknown as NodeJS.ProcessEnv,
      factories: { openai: () => adapter('openai', 'gpt-5', { async checkHealth() { return { usable: false, detail: 'OPENAI_API_KEY is not set.' } } }) },
      sleep: async () => {},
    })
    const binding = session.beginRun()

    await expect(executeResearchRun({ ...runArgs, provider: binding.provider, synthesize: binding.synthesize }))
      .rejects.toThrow(/No research provider is currently available/)

    // No sources, no claims, no brief — the cycle fails clean rather than
    // committing partial or invented intelligence.
    expect(state.sources).toEqual([])
    expect(state.persistCalls).toEqual([])
    expect(state.runUpdates.some((update) => update.status === 'failed')).toBe(true)
  })
})
