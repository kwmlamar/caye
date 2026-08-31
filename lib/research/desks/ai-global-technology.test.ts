import { describe, expect, it } from 'vitest'
import {
  AI_GLOBAL_TECHNOLOGY_DESK,
  buildAiGlobalTechnologySynthesisInstructions,
  compileAiGlobalTechnologyIntelligence,
  type AiTechnologyDevelopmentCandidate,
  type AiTechnologyEvidence,
} from './ai-global-technology'

const evidence = (
  id: string,
  independenceKey: string,
  sourceKind: AiTechnologyEvidence['sourceKind'] = 'independent',
  overrides: Partial<AiTechnologyEvidence> = {},
): AiTechnologyEvidence => ({
  id,
  url: `https://${id}.example/source`,
  independenceKey,
  sourceKind,
  region: 'United States',
  observedAt: '2026-08-30T12:00:00.000Z',
  stance: 'supports',
  summary: 'Evidence summary',
  ...overrides,
})

const candidate = (
  developmentKey: string,
  evidenceItems: AiTechnologyEvidence[],
  overrides: Partial<AiTechnologyDevelopmentCandidate> = {},
): AiTechnologyDevelopmentCandidate => ({
  developmentKey,
  title: 'A material AI capability change',
  canonicalClaim: 'A previously difficult AI capability crossed a practical threshold.',
  themes: ['agent-reliability'],
  standingQuestionIndexes: [0, 2, 7],
  materiality: {
    possibility: 0.9,
    commoditization: 0.8,
    builderDecision: 0.85,
    opportunity: 0.72,
    persistentAiTimeline: 0.76,
  },
  evidence: evidenceItems,
  ...overrides,
})

describe('AI & Global Technology Intelligence desk', () => {
  it('carries the global mission, coverage, and ten standing questions', () => {
    expect(AI_GLOBAL_TECHNOLOGY_DESK.standingQuestions).toHaveLength(10)
    expect(AI_GLOBAL_TECHNOLOGY_DESK.standingAreas).toContain('Chinese AI labs')
    expect(AI_GLOBAL_TECHNOLOGY_DESK.standingAreas).toContain('personal AI and JARVIS-style systems')
    expect(AI_GLOBAL_TECHNOLOGY_DESK.geographicScope).toEqual(expect.arrayContaining(['China', 'Africa', 'Latin America']))
    expect(AI_GLOBAL_TECHNOLOGY_DESK.sourcePolicy.preferPrimary).toBe(true)
  })

  it('turns ten reports about the same underlying change into one intelligence development', () => {
    const reports = Array.from({ length: 10 }, (_, index) =>
      candidate(
        'agent-protocols-become-commodity-infrastructure',
        [
          evidence(
            `report-${index}`,
            index < 5 ? 'shared-upstream-announcement' : `independent-${index}`,
            index === 0 ? 'primary' : 'independent',
            { region: index === 8 ? 'Europe' : 'United States' },
          ),
        ],
        { themes: ['agent-protocols', 'commodity-agent-infrastructure'] },
      ),
    )

    const result = compileAiGlobalTechnologyIntelligence(reports, [], '2026-08-31T00:00:00.000Z')
    expect(result.developments).toHaveLength(1)
    expect(result.developments[0].evidence).toHaveLength(10)
    expect(result.developments[0].sourceQuality.independentGroupCount).toBe(6)
    expect(result.developments[0].sourceQuality.primaryCount).toBe(1)
  })

  it('rewards primary plus genuinely independent corroboration over repeated retellings', () => {
    const weak = compileAiGlobalTechnologyIntelligence([
      candidate('computer-use-step-change', [
        evidence('retelling-a', 'same-rumor', 'community'),
        evidence('retelling-b', 'same-rumor', 'community'),
      ]),
    ])
    const strong = compileAiGlobalTechnologyIntelligence([
      candidate('computer-use-step-change', [
        evidence('frontier-lab', 'frontier-lab', 'primary'),
        evidence('university-eval', 'university-team', 'peer-reviewed'),
        evidence('replication-repo', 'replication-team', 'original-repo', { region: 'Europe' }),
      ]),
    ])

    expect(strong.developments[0].belief.confidence).toBeGreaterThan(weak.developments[0].belief.confidence)
    expect(strong.developments[0].evidence[0].sourceKind).toBe('primary')
    expect(strong.developments[0].sourceQuality.independentGroupCount).toBe(3)
  })

  it('keeps contradictions explicit and updates a prior belief downward', () => {
    const result = compileAiGlobalTechnologyIntelligence(
      [
        candidate('local-model-agent-parity', [
          evidence('vendor', 'vendor', 'primary'),
          evidence('eval-a', 'eval-team-a', 'peer-reviewed', { stance: 'contradicts' }),
          evidence('eval-b', 'eval-team-b', 'independent', { stance: 'contradicts', region: 'Europe' }),
        ]),
      ],
      [{ developmentKey: 'local-model-agent-parity', confidence: 0.86, state: 'supported', lastSeen: '2026-08-20T00:00:00.000Z' }],
    )

    const development = result.developments[0]
    expect(development.contradictions).toHaveLength(2)
    expect(development.belief.previousConfidence).toBe(0.86)
    expect(development.belief.delta).toBeLessThan(0)
    expect(['contested', 'weakening']).toContain(development.belief.state)
  })

  it('keeps Chinese and non-US evidence first-class', () => {
    const result = compileAiGlobalTechnologyIntelligence([
      candidate(
        'china-embodied-ai-cost-curve',
        [
          evidence('china-company', 'china-company', 'primary', { region: 'China', language: 'Chinese (Simplified)' }),
          evidence('china-university', 'china-university', 'peer-reviewed', { region: 'China', language: 'Chinese (Simplified)' }),
          evidence('japan-analysis', 'japan-research', 'independent', { region: 'Japan', language: 'Japanese' }),
        ],
        { themes: ['embodied-ai', 'robotics-cost-curve'], standingQuestionIndexes: [1, 4, 5, 9] },
      ),
    ])

    expect(result.developments[0].regions).toEqual(['China', 'Japan'])
    expect(result.developments[0].standingQuestions).toContain('What is China doing differently from the US?')
    expect(result.developments[0].standingQuestions).toContain('What important developments are occurring outside the US AI bubble?')
  })

  it('detects a cross-development, cross-region emerging trend', () => {
    const result = compileAiGlobalTechnologyIntelligence([
      candidate('browser-agents-reliable', [evidence('us-lab', 'us-lab', 'primary')]),
      candidate(
        'robot-agents-recover',
        [evidence('china-lab', 'china-lab', 'peer-reviewed', { region: 'China' })],
        { themes: ['agent-reliability', 'embodied-ai'] },
      ),
    ])

    const trend = result.emergingTrends.find((item) => item.key === 'agent-reliability')
    expect(trend?.developmentKeys).toEqual(['browser-agents-reliable', 'robot-agents-recover'])
    expect(trend?.regions).toEqual(['China', 'United States'])
  })

  it('emits stable JSON-safe intelligence and desk-specific synthesis rules', () => {
    const result = compileAiGlobalTechnologyIntelligence(
      [candidate('computer-use-step-change', [evidence('primary', 'lab', 'primary')])],
      [],
      '2026-08-31T00:00:00.000Z',
    )
    const reparsed = JSON.parse(JSON.stringify(result))
    const instructions = buildAiGlobalTechnologySynthesisInstructions()

    expect(reparsed.deskId).toBe('ai-global-technology')
    expect(reparsed.generatedAt).toBe('2026-08-31T00:00:00.000Z')
    expect(instructions).toContain('Do not produce a news feed')
    expect(instructions).toContain('independence group, not corroboration')
    expect(instructions).toContain('Actively search outside the US')
    expect(instructions).toContain('stable semantic developmentKey')
    expect(instructions).toContain('belief-strengthening')
  })
})
