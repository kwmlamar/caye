import { describe, expect, it } from 'vitest'
import {
  CROSS_DOMAIN_SYNTHESIS_DESK,
  WILDCARD_CATEGORIES,
  buildCrossDomainSynthesisInstructions,
  buildWildcardDiscoveryInstructions,
  detectWeakSignalPatterns,
  evaluateSynthesisCandidate,
  evaluateWildcardCandidate,
  wildcardCategoriesForCycle,
  type ConstituentIntelligence,
  type SynthesisCandidate,
  type WildcardCandidate,
} from './cross-domain'

const fact = (
  id: string,
  domain: string,
  overrides: Partial<ConstituentIntelligence> = {},
): ConstituentIntelligence => ({
  id,
  domain,
  statement: `${domain} development ${id}`,
  epistemicKind: 'source_fact',
  confidence: 0.8,
  sourceQuality: 'independent',
  sourceIds: [`source-${id}`],
  independenceKeys: [`independent-${id}`],
  observedAt: '2026-08-31T00:00:00.000Z',
  stance: 'supports',
  ...overrides,
})

const candidate = (overrides: Partial<SynthesisCandidate> = {}): SynthesisCandidate => ({
  id: 'synthesis-1',
  constituentIds: ['ai', 'robotics'],
  connectionKind: 'strategic',
  inferredConnection: 'Cheaper capable models and cheaper robot hardware jointly reduce the cost of embodied automation.',
  mechanism: 'Model capability lowers the software/control cost while actuator price declines lower the physical bill of materials.',
  mechanismEvidenceIds: ['ai', 'robotics'],
  assumptions: ['integration costs do not rise faster than component costs fall'],
  counterarguments: ['deployment reliability may remain the binding constraint'],
  implications: ['service robotics may become economical in additional labor-constrained workflows'],
  recommendedFollowUpResearch: ['measure total deployed system cost and reliability in target workflows'],
  affectedTargets: [{ kind: 'domain', id: 'automation', label: 'automation opportunities' }],
  confidence: 0.74,
  materiality: 'high',
  novelty: 'novel',
  ...overrides,
})

describe('cross-domain synthesis intelligence', () => {
  it('defines periodic synthesis and the eight standing anti-confirmation-bias questions', () => {
    expect(CROSS_DOMAIN_SYNTHESIS_DESK.cadence.synthesisIntervalHours).toBeGreaterThan(0)
    expect(CROSS_DOMAIN_SYNTHESIS_DESK.cadence.wildcardIntervalHours).toBeGreaterThan(0)
    expect(CROSS_DOMAIN_SYNTHESIS_DESK.standingQuestions).toHaveLength(8)
    expect(buildCrossDomainSynthesisInstructions()).toContain('Correlation is not causation')
    expect(buildCrossDomainSynthesisInstructions()).toContain('SOURCE FACT')
  })

  it('rejects unrelated facts instead of manufacturing a cross-domain connection', () => {
    const evidence = [fact('coffee', 'hospitality'), fact('comet', 'astronomy')]
    const result = evaluateSynthesisCandidate(
      candidate({
        constituentIds: ['coffee', 'comet'],
        inferredConnection: 'Coffee demand is strategically related to a newly observed comet.',
        mechanism: '',
        mechanismEvidenceIds: [],
      }),
      evidence,
    )

    expect(result.accepted).toBe(false)
    if (!result.accepted) {
      expect(result.reasons).toEqual(expect.arrayContaining([
        'explicit mechanism is required',
        'mechanism must be grounded in at least two constituent intelligence items',
      ]))
    }
  })

  it('does not let correlation masquerade as causation', () => {
    const evidence = [
      fact('labor', 'labor-market', { sourceIds: ['same-report'], independenceKeys: ['same-report'] }),
      fact('robots', 'robotics', { sourceIds: ['same-report'], independenceKeys: ['same-report'] }),
    ]
    const result = evaluateSynthesisCandidate(
      candidate({
        connectionKind: 'causal',
        constituentIds: ['labor', 'robots'],
        mechanismEvidenceIds: ['labor', 'robots'],
      }),
      evidence,
    )

    expect(result.accepted).toBe(false)
    if (!result.accepted) expect(result.reasons).toContain('causal synthesis requires at least two independent evidence groups')
  })

  it('prevents one weak source from driving a dramatic conclusion', () => {
    const evidence = [
      fact('ai', 'ai', { sourceQuality: 'community', sourceIds: ['blog'], independenceKeys: ['blog'] }),
      fact('robotics', 'robotics', { sourceQuality: 'community', sourceIds: ['blog'], independenceKeys: ['blog'] }),
    ]
    const result = evaluateSynthesisCandidate(candidate({ materiality: 'critical', confidence: 0.98 }), evidence)

    expect(result.accepted).toBe(false)
    if (!result.accepted) expect(result.reasons).toContain('weak-source-only evidence cannot support a high-materiality conclusion')
  })

  it('preserves contradictory domains and caps confidence rather than hiding disagreement', () => {
    const evidence = [
      fact('ai', 'ai'),
      fact('robotics', 'robotics'),
      fact('field-data', 'operations', {
        statement: 'Field deployments still show reliability below the threshold required for unattended operation.',
        stance: 'contradicts',
        sourceQuality: 'official',
      }),
    ]
    const result = evaluateSynthesisCandidate(
      candidate({
        constituentIds: ['ai', 'robotics', 'field-data'],
        mechanismEvidenceIds: ['ai', 'robotics'],
        confidence: 0.93,
        counterarguments: ['Field reliability may remain the binding constraint.'],
      }),
      evidence,
    )

    expect(result.accepted).toBe(true)
    if (result.accepted) {
      expect(result.artifact.contradictoryEvidence.map((item) => item.id)).toEqual(['field-data'])
      expect(result.artifact.counterarguments.join(' ')).toContain('Field deployments')
      expect(result.artifact.confidence).toBeLessThanOrEqual(0.55)
      expect(result.artifact.epistemicKind).toBe('synthesis')
      expect(result.artifact.implications.every((item) => item.epistemicKind === 'inference')).toBe(true)
      expect(result.recommendations.every((item) => item.epistemicKind === 'recommendation')).toBe(true)
    }
  })

  it('accepts a genuinely useful multi-domain connection with explicit mechanism and provenance', () => {
    const evidence = [
      fact('ai', 'ai', { sourceQuality: 'primary' }),
      fact('robotics', 'robotics', { sourceQuality: 'academic-institution' }),
      fact('labor', 'labor-market', {
        statement: 'Vacancy duration is rising in repetitive physical-work categories.',
        sourceQuality: 'official',
      }),
    ]
    const result = evaluateSynthesisCandidate(
      candidate({
        constituentIds: ['ai', 'robotics', 'labor'],
        mechanismEvidenceIds: ['ai', 'robotics', 'labor'],
        inferredConnection: 'Falling automation input costs become more strategically valuable where labor scarcity raises the cost of leaving work unfilled.',
        mechanism: 'Lower model and hardware cost reduces automation capex while persistent vacancies increase the avoided-cost value of deployment.',
        affectedTargets: [{ kind: 'objective', id: 'find-high-leverage-business-opportunities' }],
      }),
      evidence,
    )

    expect(result.accepted).toBe(true)
    if (result.accepted) {
      expect(result.artifact.evidenceSummary.distinctDomains).toBe(3)
      expect(result.artifact.evidenceSummary.independentGroups).toBe(3)
      expect(result.artifact.constituentIntelligence).toHaveLength(3)
      expect(result.artifact.mechanism).toContain('automation capex')
    }
  })
})

describe('wildcard discovery', () => {
  const wildcard = (overrides: Partial<WildcardCandidate> = {}): WildcardCandidate => ({
    id: 'wildcard-1',
    category: 'infrastructure-shifts',
    discoveredDomain: 'industrial-cold-storage',
    evidence: [fact('grid', 'infrastructure', { sourceQuality: 'official' }), fact('warehouse', 'industrial-logistics')],
    relevancePath: {
      development: 'Grid interconnection queues are changing where new power-intensive facilities can be deployed.',
      mechanism: 'Long connection delays make sites with existing power access materially more valuable.',
      affectedObjectiveOrDomain: { kind: 'objective', id: 'find-high-leverage-business-opportunities' },
      potentialImplication: 'Existing powered industrial sites may become an underappreciated bottleneck or acquisition opportunity.',
    },
    confidence: 0.72,
    materiality: 'medium',
    novelty: 'wildcard',
    followUpResearch: ['compare interconnection wait times with powered-site transaction values'],
    ...overrides,
  })

  it('covers every requested wildcard category and rotates exploration deliberately', () => {
    expect(WILDCARD_CATEGORIES).toHaveLength(10)
    expect(WILDCARD_CATEGORIES).toEqual(expect.arrayContaining([
      'emerging-technologies',
      'regulatory-changes',
      'demographic-changes',
      'geopolitical-developments',
      'supply-chain-changes',
      'cultural-behavioral-changes',
    ]))
    expect(wildcardCategoriesForCycle(0, 3)).toEqual(WILDCARD_CATEGORIES.slice(0, 3))
    expect(wildcardCategoriesForCycle(9, 3)).toEqual([
      'cultural-behavioral-changes',
      'emerging-technologies',
      'unusual-industries',
    ])
    expect(buildWildcardDiscoveryInstructions(['scientific-breakthroughs'])).toContain('development -> mechanism -> affected objective/domain -> potential implication')
  })

  it('rejects wildcard trivia without the complete relevance path', () => {
    const result = evaluateWildcardCandidate({
      candidate: wildcard({
        relevancePath: {
          development: 'A niche material set a new laboratory record.',
          mechanism: '',
          affectedObjectiveOrDomain: { kind: 'objective', id: 'find-high-leverage-business-opportunities' },
          potentialImplication: '',
        },
      }),
      monitoredDomains: ['ai'],
      activeObjectiveIds: ['find-high-leverage-business-opportunities'],
    })

    expect(result.accepted).toBe(false)
    if (!result.accepted) {
      expect(result.reasons).toEqual(expect.arrayContaining([
        'wildcard relevance path requires a mechanism',
        'wildcard relevance path requires a potential implication',
      ]))
    }
  })

  it('rejects a wildcard with no connection to an active objective or monitored domain', () => {
    const result = evaluateWildcardCandidate({
      candidate: wildcard({
        relevancePath: {
          ...wildcard().relevancePath,
          affectedObjectiveOrDomain: { kind: 'objective', id: 'nonexistent-objective' },
        },
      }),
      monitoredDomains: ['ai'],
      activeObjectiveIds: ['actual-objective'],
    })

    expect(result.accepted).toBe(false)
    if (!result.accepted) expect(result.reasons).toContain('wildcard has no explicit relevance path to an active objective or monitored domain')
  })

  it('surfaces a relevant unmonitored domain as a monitoring gap without pretending the wildcard itself is a fact', () => {
    const result = evaluateWildcardCandidate({
      candidate: wildcard(),
      monitoredDomains: ['ai', 'robotics'],
      activeObjectiveIds: ['find-high-leverage-business-opportunities'],
    })

    expect(result.accepted).toBe(true)
    if (result.accepted) {
      expect(result.monitoringGap).toBe(true)
      expect(result.epistemicPath.fact.every((item) => item.epistemicKind === 'source_fact')).toBe(true)
      expect(result.epistemicPath.synthesis).toContain('may matter because')
    }
  })
})

describe('weak-signal pattern detection', () => {
  it('requires recurrence plus independent evidence and one explicit mechanism', () => {
    const base = {
      patternKey: 'power-constrained-compute-sites',
      mechanism: 'Power availability constrains expansion before compute hardware availability does.',
    }
    const signals = [
      { ...fact('s1', 'infrastructure'), ...base },
      { ...fact('s2', 'data-centers'), ...base },
      { ...fact('s3', 'energy'), ...base },
    ]
    expect(detectWeakSignalPatterns(signals)).toHaveLength(1)

    const repeatedRetelling = signals.map((signal) => ({
      ...signal,
      sourceIds: ['same-upstream'],
      independenceKeys: ['same-upstream'],
    }))
    expect(detectWeakSignalPatterns(repeatedRetelling)).toHaveLength(0)
  })
})
