import { describe, expect, it } from 'vitest'
import {
  compileAiGlobalTechnologyIntelligence,
  type AiTechnologyDevelopmentCandidate,
} from './ai-global-technology'

describe('AI technology corroboration boundary', () => {
  it('does not promote a single upstream primary source to supported/high confidence', () => {
    const candidate: AiTechnologyDevelopmentCandidate = {
      developmentKey: 'single-lab-capability-claim',
      title: 'A frontier lab announces a major capability gain',
      canonicalClaim: 'The announced capability gain materially changes what agents can do.',
      themes: ['agents'],
      standingQuestionIndexes: [0],
      materiality: {
        possibility: 0.9,
        commoditization: 0.5,
        builderDecision: 0.7,
        opportunity: 0.7,
        persistentAiTimeline: 0.6,
      },
      evidence: [{
        id: 'primary-announcement',
        url: 'https://frontier-lab.example/announcement',
        publisher: 'Frontier Lab',
        sourceKind: 'primary',
        independenceKey: 'frontier-lab',
        region: 'United States',
        observedAt: '2026-08-31T00:00:00.000Z',
        stance: 'supports',
        summary: 'The lab directly reports the new capability.',
      }],
    }

    const result = compileAiGlobalTechnologyIntelligence([candidate])
    expect(result.developments[0].sourceQuality.independentGroupCount).toBe(1)
    expect(result.developments[0].belief.confidence).toBeLessThan(0.72)
    expect(result.developments[0].belief.state).toBe('emerging')
  })
})
