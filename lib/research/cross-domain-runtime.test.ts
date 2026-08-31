import { describe, expect, it } from 'vitest'
import type { ConstituentIntelligence, SynthesisCandidate } from './cross-domain'
import {
  runCrossDomainSynthesis,
  synthesisFingerprint,
  type CrossDomainContext,
  type CrossDomainRuntimeStore,
  type PersistedSynthesis,
} from './cross-domain-runtime'

function fact(
  id: string,
  domain: string,
  overrides: Partial<ConstituentIntelligence> = {},
): ConstituentIntelligence {
  return {
    id,
    domain,
    statement: `${domain} evidence ${id}`,
    epistemicKind: 'source_fact',
    confidence: 0.84,
    sourceQuality: 'independent',
    sourceIds: [`source-${id}`],
    independenceKeys: [`publisher-${id}`],
    observedAt: '2026-08-31T12:00:00.000Z',
    stance: 'supports',
    ...overrides,
  }
}

function candidate(overrides: Partial<SynthesisCandidate> = {}): SynthesisCandidate {
  return {
    id: 'ai-market',
    constituentIds: ['ai', 'market'],
    connectionKind: 'strategic',
    inferredConnection: 'Falling inference costs can expand the economically viable market for AI-agent workflows.',
    mechanism: 'Lower model cost reduces unit economics for automated workflows while buyer demand determines which workflows become commercially viable.',
    mechanismEvidenceIds: ['ai', 'market'],
    assumptions: ['Model price declines persist long enough to affect product economics.'],
    counterarguments: ['Adoption friction may offset raw inference-cost declines.'],
    implications: ['Caye can reevaluate which autonomous workflows are affordable to run continuously.'],
    recommendedFollowUpResearch: ['Which Caye workflows cross a positive unit-economics threshold under current model pricing?'],
    affectedTargets: [{ kind: 'objective', id: 'goal-caye', label: 'Build durable Caye intelligence' }],
    confidence: 0.78,
    materiality: 'high',
    novelty: 'novel',
    ...overrides,
  }
}

function context(overrides: Partial<CrossDomainContext> = {}): CrossDomainContext {
  return {
    evidence: [fact('ai', 'ai'), fact('market', 'markets')],
    activeObjectives: [{ id: 'goal-caye', title: 'Build durable Caye intelligence', priority: 'high' }],
    monitoredDomains: ['ai', 'markets'],
    weakSignals: [],
    recentBeliefRevisionIds: [],
    trigger: 'periodic',
    ...overrides,
  }
}

class FakeStore implements CrossDomainRuntimeStore {
  contexts: CrossDomainContext[]
  fingerprints = new Map<string, string>()
  relations: unknown[] = []
  impacts: unknown[] = []
  followUps: unknown[] = []
  wildcards: unknown[] = []
  alerts: unknown[] = []

  constructor(...contexts: CrossDomainContext[]) {
    this.contexts = contexts
  }

  async loadContext() {
    const next = this.contexts.shift()
    if (!next) throw new Error('missing fake context')
    return next
  }

  async claimIdsForItems(itemIds: string[]) {
    return Object.fromEntries(itemIds.map((id) => [id, [`claim-${id}`]]))
  }

  async persistSynthesis(artifact: Parameters<CrossDomainRuntimeStore['persistSynthesis']>[0], fingerprint: string): Promise<PersistedSynthesis> {
    const itemId = `stored:${artifact.id}`
    const changed = this.fingerprints.get(itemId) !== fingerprint
    this.fingerprints.set(itemId, fingerprint)
    return { itemId, fingerprint, changed }
  }

  async persistGroundedRelation(input: Parameters<CrossDomainRuntimeStore['persistGroundedRelation']>[0]) {
    this.relations.push(input)
  }

  async linkObjectiveImpact(input: Parameters<CrossDomainRuntimeStore['linkObjectiveImpact']>[0]) {
    this.impacts.push(input)
  }

  async queueFollowUpResearch(input: Parameters<CrossDomainRuntimeStore['queueFollowUpResearch']>[0]) {
    this.followUps.push(input)
  }

  async persistWildcard(input: Parameters<CrossDomainRuntimeStore['persistWildcard']>[0], fingerprint: string) {
    this.wildcards.push({ input, fingerprint })
  }

  async raiseStrategicAttention(input: Parameters<CrossDomainRuntimeStore['raiseStrategicAttention']>[0]) {
    this.alerts.push(input)
    return true
  }
}

describe('cross-domain synthesis runtime', () => {
  it('persists a meaningful AI + market connection, grounded relations, objective impact, and material attention', async () => {
    const store = new FakeStore(context())
    const result = await runCrossDomainSynthesis({ store, reasoner: async () => ({ syntheses: [candidate()], wildcards: [] }) })

    expect(result.accepted).toBe(1)
    expect(result.changed).toBe(1)
    expect(store.relations).toHaveLength(2)
    expect(store.impacts).toHaveLength(1)
    expect(store.followUps).toHaveLength(1)
    expect(store.alerts).toHaveLength(1)
  })

  it('rejects a meaningless two-domain coincidence with no grounded mechanism', async () => {
    const store = new FakeStore(context())
    const result = await runCrossDomainSynthesis({
      store,
      reasoner: async () => ({ syntheses: [candidate({ mechanism: ' ', mechanismEvidenceIds: [] })], wildcards: [] }),
    })

    expect(result.accepted).toBe(0)
    expect(result.rejected[0]?.reasons).toContain('explicit mechanism is required')
    expect(store.impacts).toHaveLength(0)
  })

  it('links an objective impact only when an explicit cross-domain mechanism survives the gate', async () => {
    const store = new FakeStore(context())
    await runCrossDomainSynthesis({ store, reasoner: async () => ({ syntheses: [candidate()], wildcards: [] }) })

    expect(store.impacts).toHaveLength(1)
    expect(store.impacts[0]).toMatchObject({
      goalId: 'goal-caye',
      mechanism: expect.stringContaining('Lower model cost'),
      evidenceClaimIds: expect.arrayContaining(['claim-ai','claim-market']),
    })
  })

  it('detects recurring weak signals only after independent recurrence', async () => {
    const signals = [
      fact('w1','ai',{ sourceQuality:'community', sourceIds:['s1'], independenceKeys:['p1'] }),
      fact('w2','markets',{ sourceQuality:'community', sourceIds:['s2'], independenceKeys:['p2'] }),
      fact('w3','policy',{ sourceQuality:'community', sourceIds:['s3'], independenceKeys:['p3'] }),
    ].map((item) => ({ ...item, patternKey: 'agent-cost-compression', mechanism: 'Multiple independent signals point to falling agent operating cost.' }))
    const store = new FakeStore(context({ weakSignals: signals }))
    const result = await runCrossDomainSynthesis({ store, reasoner: async () => ({ syntheses: [], wildcards: [] }) })

    expect(result.weakSignalPatterns).toHaveLength(1)
    expect(result.weakSignalPatterns[0]?.signalIds).toEqual(['w1','w2','w3'])
  })

  it('rejects causal overclaiming without independent strong evidence', async () => {
    const weakEvidence = [
      fact('ai','ai',{ sourceQuality:'community', independenceKeys:['same-source'], sourceIds:['same-source'] }),
      fact('market','markets',{ sourceQuality:'community', independenceKeys:['same-source'], sourceIds:['same-source'] }),
    ]
    const store = new FakeStore(context({ evidence: weakEvidence }))
    const result = await runCrossDomainSynthesis({
      store,
      reasoner: async () => ({ syntheses: [candidate({ connectionKind: 'causal' })], wildcards: [] }),
    })

    expect(result.accepted).toBe(0)
    expect(result.rejected[0]?.reasons).toContain('causal synthesis requires at least two independent evidence groups')
  })

  it('does not create objective attention when no active objective is relevant', async () => {
    const store = new FakeStore(context({ activeObjectives: [], monitoredDomains: ['ai','markets'] }))
    const domainOnly = candidate({ affectedTargets: [{ kind: 'domain', id: 'ai' }] })
    const result = await runCrossDomainSynthesis({ store, reasoner: async () => ({ syntheses: [domainOnly], wildcards: [] }) })

    expect(result.accepted).toBe(1)
    expect(store.impacts).toHaveLength(0)
    expect(store.alerts).toHaveLength(0)
  })

  it('does not re-alert or requeue follow-up research for unchanged synthesis', async () => {
    const store = new FakeStore(context(), context())
    const reasoner = async () => ({ syntheses: [candidate()], wildcards: [] })
    const first = await runCrossDomainSynthesis({ store, reasoner })
    const second = await runCrossDomainSynthesis({ store, reasoner })

    expect(first.alertsRaised).toBe(1)
    expect(second.changed).toBe(0)
    expect(second.alertsRaised).toBe(0)
    expect(store.alerts).toHaveLength(1)
    expect(store.followUps).toHaveLength(1)
  })

  it('new contradictory evidence changes the synthesis fingerprint and causes reassessment', async () => {
    const base = context()
    const contradiction = fact('market-contrary','markets',{
      statement: 'Enterprise buyers are slowing AI-agent deployment because integration cost remains high.',
      stance: 'contradicts',
    })
    const revised = context({ evidence: [...base.evidence, contradiction], trigger: 'material-belief-change', recentBeliefRevisionIds: ['revision-1'] })
    const store = new FakeStore(base, revised)
    const firstCandidate = candidate()
    const secondCandidate = candidate({
      constituentIds: ['ai','market','market-contrary'],
      mechanismEvidenceIds: ['ai','market'],
      counterarguments: ['Integration costs may dominate inference savings for some enterprises.'],
    })

    let call = 0
    const reasoner = async () => ({ syntheses: [call++ === 0 ? firstCandidate : secondCandidate], wildcards: [] })
    await runCrossDomainSynthesis({ store, reasoner })
    const firstFingerprint = store.fingerprints.get('stored:ai-market')
    const second = await runCrossDomainSynthesis({ store, reasoner })
    const secondFingerprint = store.fingerprints.get('stored:ai-market')

    expect(firstFingerprint).toBeTruthy()
    expect(secondFingerprint).toBeTruthy()
    expect(secondFingerprint).not.toBe(firstFingerprint)
    expect(second.trigger).toBe('material-belief-change')
    expect(second.changed).toBe(1)
    expect(store.alerts).toHaveLength(2)
  })

  it('fingerprints are stable for equivalent deterministic artifacts', async () => {
    const store = new FakeStore(context())
    let captured: string | undefined
    const originalPersist = store.persistSynthesis.bind(store)
    store.persistSynthesis = async (artifact, fingerprint) => {
      captured = fingerprint
      expect(fingerprint).toBe(synthesisFingerprint(artifact))
      return originalPersist(artifact, fingerprint)
    }
    await runCrossDomainSynthesis({ store, reasoner: async () => ({ syntheses: [candidate()], wildcards: [] }) })
    expect(captured).toMatch(/^[a-f0-9]{64}$/)
  })
})
