import { describe, expect, it } from 'vitest'
import {
  AI_GLOBAL_TECHNOLOGY_DESK,
  buildAiGlobalTechnologySynthesisInstructions,
  compileAiGlobalTechnologyIntelligence,
  type AiTechnologyDevelopmentCandidate,
  type AiTechnologyEvidence,
} from './ai-global-technology'

function evidence(overrides: Partial<AiTechnologyEvidence> & Pick<AiTechnologyEvidence, 'id' | 'url' | 'independenceKey'>): AiTechnologyEvidence {
  return {
    id: overrides.id,
    url: overrides.url,
    independenceKey: overrides.independenceKey,
    title: overrides.title ?? 'Source',
    publisher: overrides.publisher ?? 'Publisher',
    sourceKind: overrides.sourceKind ?? 'independent',
    region: overrides.region ?? 'United States',
    language: overrides.language ?? 'English',
    publishedAt: overrides.publishedAt,
    observedAt: overrides.observedAt ?? '2026-08-30T12:00:00.000Z',
    stance: overrides.stance ?? 'supports',
    summary: overrides.summary ?? 'Evidence summary',
  }
}

function candidate(overrides: Partial<AiTechnologyDevelopmentCandidate> = {}): AiTechnologyDevelopmentCandidate {
  return {
    developmentKey: overrides.developmentKey ?? 'frontier-computer-use-reliability-step-change',
    title: overrides.title ?? 'Computer-use reliability crosses a practical threshold',
    canonicalClaim:
      overrides.canonicalClaim ??
      'Frontier computer-use systems can now complete materially longer browser workflows with fewer interventions than the prior generation.',
    themes: overrides.themes ?? ['computer-use', 'agents'],
    standingQuestionIndexes: overrides.standingQuestionIndexes ?? [0, 2, 7],
    materiality: overrides.materiality ?? {
      possibility: 0.9,
      commoditization: 0.82,
      builderDecision: 0.88,
      opportunity: 0.74,
      persistentAiTimeline: 0.79,
    },
    evidence:
      overrides.evidence ??
      [
        evidence({
          id: 'anthropic-primary',
          url: 'https://www.anthropic.com/news/computer-use-update',
          independenceKey: 'anthropic',
          publisher: 'Anthropic',
          sourceKind: 'primary',
        }),
      ],
  }
}

describe('AI & Global Technology Intelligence desk', () => {
  it('defines the requested global mission and standing questions', () => {
    expect(AI_GLOBAL_TECHNOLOGY_DESK.standingQuestions).toHaveLength(10)
    expect(AI_GLOBAL_TECHNOLOGY_DESK.standingAreas).toContain('Chinese AI labs')
    expect(AI_GLOBAL_TECHNOLOGY_DESK.standingAreas).toContain('personal AI and JARVIS-style systems')
    expect(AI_GLOBAL_TECHNOLOGY_DESK.geographicScope).toContain('China')
    expect(AI_GLOBAL_TECHNOLOGY_DESK.geographicScope).toContain('Africa')
    expect(AI_GLOBAL_TECHNOLOGY_DESK.sourcePolicy.preferPrimary).toBe(true)
    expect(AI_GLOBAL_TECHNOLOGY_DESK.sourcePolicy.preserveContradictions).toBe(true)
  })

  it('collapses ten reports about one underlying change into one development', () => {
    const reports = Array.from({ length: 10 }, (_, index) =>
      candidate({
        developmentKey: 'agent-protocol-interoperability-becomes-provider-infrastructure',
        title: index % 2 ? 'Agent interoperability moves into platforms' : 'Agent protocols become infrastructure',
        canonicalClaim: 'Major providers are converging on interoperable agent/tool protocols as platform infrastructure.',
        themes: ['agent-protocols', 'commodity-agent-infrastructure'],
        evidence: [
          evidence({
            id: `report-${index}`,
            url: `https://source-${index}.example/report`,
            independenceKey: index < 5 ? 'same-upstream-announcement' : `independent-${index}`,
            sourceKind: index === 0 ? 'primary' : 'independent',
            region: index === 7 ? 'Europe' : 'United States',
          }),
        ],
      }),
    )

    const result = compileAiGlobalTechnologyIntelligence(reports, [], '2026-08-31T00:00:00.000Z')

    expect(result.developments).toHaveLength(1)
    expect(result.developments[0].evidence).toHaveLength(10)
    expect(result.developments[0].sourceQuality.independentGroupCount).toBe(6)
    expect(result.developments[0].sourceQuality.primaryCount).toBe(1)
  })

  it('prefers primary evidence and rewards genuinely independent corroboration', () => {
    const weak = compileAiGlobalTechnologyIntelligence([
      candidate({
        evidence: [
          evidence({
            id: 'retelling-a',
            url: 'https://news-a.example/story',
            independenceKey: 'upstream-rumor',
            sourceKind: 'community',
          }),
          evidence({
            id: 'retelling-b',
            url: 'https://news-b.example/story',
            independenceKey: 'upstream-rumor',
            sourceKind: 'community',
          }),
        ],
      }),
    ])

    const corroborated = compileAiGlobalTechnologyIntelligence([
      candidate({
        evidence: [
          evidence({
            id: 'lab-release',
            url: 'https://deepmind.google/discover/blog/robotics-release',
            independenceKey: 'deepmind',
            sourceKind: 'primary',
          }),
          evidence({
            id: 'paper',
            url: 'https://arxiv.org/abs/2608.12345',
            independenceKey: 'independent-university-team',
            sourceKind: 'peer-reviewed',
          }),
          evidence({
            id: 'replication',
            url: 'https://github.com/example/replication',
            independenceKey: 'open-source-replication-team',
            sourceKind: 'original-repo',
            region: 'Europe',
          }),
        ],
      }),
    ])

    expect(corroborated.developments[0].belief.confidence).toBeGreaterThan(weak.developments[0].belief.confidence)
    expect(corroborated.developments[0].evidence[0].sourceKind).toBe('primary')
    expect(corroborated.developments[0].sourceQuality.independentGroupCount).toBe(3)
  })

  it('preserves contradictions and records a weakening belief update', () => {
    const result = compileAiGlobalTechnologyIntelligence(
      [
        candidate({
          developmentKey: 'local-model-agent-cost-parity',
          evidence: [
            evidence({
              id: 'vendor-benchmark',
              url: 'https://vendor.example/benchmark',
              independenceKey: 'vendor',
              sourceKind: 'primary',
              summary: 'Vendor benchmark reports near-frontier task quality at much lower inference cost.',
            }),
            evidence({
              id: 'independent-eval-a',
              url: 'https://lab.example/evaluation',
              independenceKey: 'eval-lab-a',
              sourceKind: 'peer-reviewed',
              stance: 'contradicts',
              summary: 'Independent evaluation finds large reliability regressions on long-horizon tasks.',
            }),
            evidence({
              id: 'independent-eval-b',
              url: 'https://research.example/agent-eval',
              independenceKey: 'eval-lab-b',
              sourceKind: 'independent',
              stance: 'contradicts',
              region: 'Europe',
              summary: 'Second evaluation reproduces the long-horizon reliability gap.',
            }),
          ],
        }),
      ],
      [
        {
          developmentKey: 'local-model-agent-cost-parity',
          confidence: 0.86,
          state: 'supported',
          lastSeen: '2026-08-20T00:00:00.000Z',
        },
      ],
    )

    expect(result.developments[0].contradictions).toHaveLength(2)
    expect(result.developments[0].belief.previousConfidence).toBe(0.86)
    expect(result.developments[0].belief.delta).toBeLessThan(0)
    expect(['contested', 'weakening']).toContain(result.developments[0].belief.state)
  })

  it('keeps Chinese and non-US evidence first-class instead of flattening it into a US news view', () => {
    const result = compileAiGlobalTechnologyIntelligence([
      candidate({
        developmentKey: 'china-embodied-ai-cost-curve',
        title: 'Chinese robotics stack pushes embodied AI cost downward',
        themes: ['embodied-ai', 'robotics-cost-curve'],
        standingQuestionIndexes: [1, 4, 5, 9],
        evidence: [
          evidence({
            id: 'cn-company',
            url: 'https://robotics-cn.example/release',
            independenceKey: 'cn-robotics-company',
            sourceKind: 'primary',
            region: 'China',
            language: 'Chinese (Simplified)',
          }),
          evidence({
            id: 'cn-university',
            url: 'https://university-cn.example/paper',
            independenceKey: 'cn-university',
            sourceKind: 'peer-reviewed',
            region: 'China',
            language: 'Chinese (Simplified)',
          }),
          evidence({
            id: 'jp-analysis',
            url: 'https://research-jp.example/robotics',
            independenceKey: 'jp-research-group',
            sourceKind: 'independent',
            region: 'Japan',
            language: 'Japanese',
          }),
        ],
      }),
    ])

    expect(result.developments[0].regions).toEqual(['China', 'Japan'])
    expect(result.developments[0].standingQuestions).toContain('What is China doing differently from the US?')
    expect(result.developments[0].standingQuestions).toContain('What important developments are occurring outside the US AI bubble?')
  })

  it('detects an emerging trend across separate developments and regions', () => {
    const result = compileAiGlobalTechnologyIntelligence([
      candidate({
        developmentKey: 'browser-agents-reliable',
        themes: ['long-horizon-agent-reliability'],
        evidence: [
          evidence({
            id: 'us-agent',
            url: 'https://lab-us.example/release',
            independenceKey: 'us-lab',
            sourceKind: 'primary',
            region: 'United States',
          }),
        ],
      }),
      candidate({
        developmentKey: 'robot-agents-recover-from-errors',
        title: 'Robotic agents recover from execution failures',
        canonicalClaim: 'New embodied systems recover from a broader class of execution failures without human resets.',
        themes: ['long-horizon-agent-reliability', 'embodied-ai'],
        evidence: [
          evidence({
            id: 'cn-robotics',
            url: 'https://lab-cn.example/paper',
            independenceKey: 'cn-lab',
            sourceKind: 'peer-reviewed',
            region: 'China',
          }),
        ],
      }),
    ])

    const trend = result.emergingTrends.find((item) => item.key === 'long-horizon-agent-reliability')
    expect(trend).toBeDefined()
    expect(trend?.developmentKeys).toEqual(['browser-agents-reliable', 'robot-agents-recover-from-errors'])
    expect(trend?.regions).toEqual(['China', 'United States'])
  })

  it('produces stable JSON-safe intelligence for later synthesis', () => {
    const result = compileAiGlobalTechnologyIntelligence(
      [candidate()],
      [],
      '2026-08-31T00:00:00.000Z',
    )

    const reparsed = JSON.parse(JSON.stringify(result))
    expect(reparsed.deskId).toBe('ai-global-technology')
    expect(reparsed.generatedAt).toBe('2026-08-31T00:00:00.000Z')
    expect(reparsed.developments[0].canonicalClaim).toContain('Frontier computer-use systems')
  })

  it('tells synthesis to aggregate developments, evaluate independence, and search globally', () => {
    const instructions = buildAiGlobalTechnologySynthesisInstructions()
    expect(instructions).toContain('Do not produce a news feed')
    expect(instructions).toContain('same independence group, not corroboration')
    expect(instructions).toContain('Actively search outside the US')
    expect(instructions).toContain('stable semantic developmentKey')
    expect(instructions).toContain('belief-strengthening')
  })
})
