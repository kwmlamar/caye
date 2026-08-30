import { describe, expect, it } from 'vitest'
import { analyzeDecision, compareDecisionOutcome, type DecisionAnalysisInput } from './decision-intelligence'

function baseInput(): DecisionAnalysisInput {
  return {
    workspaceId: 'workspace-1',
    situation: 'Choose a bounded recovery strategy for an engineering service.',
    evidence: [
      { ref: 'analysis:latency', statement: 'Retries recover transient failures.', epistemicKind: 'known', direction: 'supports', confidence: 'high' },
      { ref: 'analysis:blast-radius', statement: 'Restarting the whole service interrupts healthy traffic.', epistemicKind: 'known', direction: 'supports', confidence: 'high' },
    ],
    unknowns: [],
    alternatives: [
      {
        id: 'bounded-retry', label: 'Bounded retry', description: 'Retry the failed operation with a strict cap.',
        reversibility: 'reversible', requiresConsequentialAction: false,
        evidenceRefs: ['analysis:latency'], assumptions: [],
        consequences: [
          { dimension: 'recovery', direction: 'benefit', magnitude: 'major', likelihood: 'likely', rationale: 'Observed failures are transient.' },
          { dimension: 'load', direction: 'risk', magnitude: 'minor', likelihood: 'plausible', rationale: 'A small retry burst adds load.' },
        ],
      },
      {
        id: 'full-restart', label: 'Full restart', description: 'Restart the whole service.',
        reversibility: 'partially_reversible', requiresConsequentialAction: true,
        evidenceRefs: ['analysis:blast-radius'], assumptions: [],
        consequences: [
          { dimension: 'recovery', direction: 'benefit', magnitude: 'material', likelihood: 'plausible', rationale: 'A restart may clear state.' },
          { dimension: 'availability', direction: 'risk', magnitude: 'major', likelihood: 'likely', rationale: 'Healthy traffic is interrupted.' },
        ],
      },
    ],
    predictions: [
      { alternativeId: 'bounded-retry', expectation: 'The failed operation recovers without broad interruption.', observable: 'operation succeeds and healthy traffic remains available', horizon: 'next recovery attempt', confidence: 'high' },
    ],
  }
}

describe('decision intelligence', () => {
  it('recommends a clearly superior reversible option without fabricated precision', () => {
    const result = analyzeDecision(baseInput())
    expect(result.recommendation).toMatchObject({
      disposition: 'recommend', alternativeId: 'bounded-retry', confidence: 'high', authority: 'autonomous', evidenceState: 'sufficient',
    })
    expect(JSON.stringify(result)).not.toMatch(/\b\d+\.\d+%|probability/i)
  })

  it('fails honestly when evidence is missing', () => {
    const input = baseInput()
    input.evidence = []
    input.alternatives.forEach((alternative) => { alternative.evidenceRefs = [] })
    const result = analyzeDecision(input)
    expect(result.recommendation).toMatchObject({ disposition: 'investigate', alternativeId: null, confidence: 'low', evidenceState: 'missing' })
  })

  it('abstains on contradictory evidence', () => {
    const input = baseInput()
    input.evidence.push({ ref: 'analysis:retry-risk', statement: 'Retries amplify the current failure mode.', epistemicKind: 'known', direction: 'contradicts', confidence: 'high' })
    input.alternatives[0].evidenceRefs.push('analysis:retry-risk')
    const result = analyzeDecision(input)
    expect(result.recommendation).toMatchObject({ disposition: 'investigate', alternativeId: null, evidenceState: 'contradictory' })
  })

  it('abstains on ambiguous evidence and low-confidence assumptions', () => {
    const input = baseInput()
    input.unknowns = ['Whether the dependency is rate-limiting requests.']
    input.alternatives[0].assumptions = [{ id: 'rate-limit', statement: 'The dependency is not rate limiting.', confidence: 'low' }]
    const result = analyzeDecision(input)
    expect(result.recommendation.disposition).toBe('investigate')
    expect(result.recommendation.alternativeId).toBeNull()
  })

  it('abstains on a near tie', () => {
    const input = baseInput()
    input.evidence = [
      { ref: 'analysis:a', statement: 'Option A has evidence.', epistemicKind: 'known', direction: 'supports', confidence: 'medium' },
      { ref: 'analysis:b', statement: 'Option B has evidence.', epistemicKind: 'known', direction: 'supports', confidence: 'medium' },
    ]
    input.alternatives[0].evidenceRefs = ['analysis:a']
    input.alternatives[1].evidenceRefs = ['analysis:b']
    input.alternatives[0].consequences = [{ dimension: 'result', direction: 'benefit', magnitude: 'material', likelihood: 'plausible', rationale: 'Comparable expected benefit.' }]
    input.alternatives[1].consequences = [{ dimension: 'result', direction: 'benefit', magnitude: 'material', likelihood: 'plausible', rationale: 'Comparable expected benefit.' }]
    const result = analyzeDecision(input)
    expect(result.recommendation).toMatchObject({ disposition: 'investigate', alternativeId: null, confidence: 'low' })
  })

  it('requires approval for a consequential or irreversible recommendation', () => {
    const input = baseInput()
    input.alternatives[0].requiresConsequentialAction = true
    input.alternatives[0].reversibility = 'irreversible'
    const result = analyzeDecision(input)
    expect(result.recommendation).toMatchObject({ disposition: 'recommend', alternativeId: 'bounded-retry', authority: 'approval_required' })
    expect(result.recommendation.reasons.join(' ')).toContain('explicit approval')
  })

  it('keeps known and inferred evidence explicit', () => {
    const input = baseInput()
    input.evidence.push({ ref: 'analysis:inference', statement: 'The retry path is probably isolated.', epistemicKind: 'inferred', direction: 'context', confidence: 'low' })
    const result = analyzeDecision(input)
    expect(result.evidence.find((item) => item.ref === 'analysis:inference')?.epistemicKind).toBe('inferred')
  })

  it('produces a deterministic persistence shape regardless of input ordering', () => {
    const first = analyzeDecision(baseInput())
    const reversed = baseInput()
    reversed.alternatives.reverse()
    reversed.evidence.reverse()
    const second = analyzeDecision(reversed)
    expect(second).toEqual(first)
  })

  it('compares a recorded prediction against later observed reality', () => {
    const record = analyzeDecision(baseInput())
    const comparison = compareDecisionOutcome(record, {
      alternativeId: 'bounded-retry', observed: 'The operation recovered and traffic stayed healthy.', evidenceRefs: ['execution:run-1'], verdict: 'matched', notes: [],
    })
    expect(comparison).toMatchObject({ alternativeId: 'bounded-retry', comparison: 'supported' })
    expect(comparison.prediction?.observable).toContain('healthy traffic')
  })

  it('enforces bounded alternatives and evidence references', () => {
    const input = baseInput()
    input.alternatives = [...input.alternatives, ...input.alternatives.map((item, index) => ({ ...item, id: `${item.id}-${index}` })), { ...input.alternatives[0], id: 'sixth' }, { ...input.alternatives[1], id: 'seventh' }]
    expect(() => analyzeDecision(input)).toThrow(/2-5 options/)

    const badRef = baseInput()
    badRef.alternatives[0].evidenceRefs = ['analysis:made-up']
    expect(() => analyzeDecision(badRef)).toThrow(/unknown evidence/)
  })
})
