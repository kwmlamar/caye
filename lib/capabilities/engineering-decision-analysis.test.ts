import { beforeEach, describe, expect, it, vi } from 'vitest'

const inMock = vi.fn()
const eqMock = vi.fn(() => ({ in: inMock }))
const selectMock = vi.fn(() => ({ eq: eqMock }))
const fromMock = vi.fn(() => ({ select: selectMock }))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({ from: fromMock }),
}))

import { engineeringDecisionAnalysisCapability } from './engineering-decision-analysis'
import type { CapabilityExecutionContext } from './types'

const context = (workspaceId: string | null): CapabilityExecutionContext => ({
  actor: { kind: 'founder', userId: 'founder-1' },
  scope: { workspaceId },
  caller: 'external_reasoner',
})

function args(ref = 'artifact-1') {
  return {
    mode: 'analyze' as const,
    decision: {
      situation: 'Choose an engineering recovery strategy.',
      evidence: [{ ref, statement: 'The bounded retry recovered the observed transient failure.', epistemicKind: 'known' as const, direction: 'supports' as const, confidence: 'high' as const }],
      unknowns: [],
      alternatives: [
        {
          id: 'retry', label: 'Bounded retry', description: 'Retry once with a strict cap.', reversibility: 'reversible' as const,
          requiresConsequentialAction: false, evidenceRefs: [ref], assumptions: [],
          consequences: [{ dimension: 'recovery', direction: 'benefit' as const, magnitude: 'major' as const, likelihood: 'likely' as const, rationale: 'Matches the observed transient failure.' }],
        },
        {
          id: 'restart', label: 'Restart service', description: 'Restart the entire service.', reversibility: 'partially_reversible' as const,
          requiresConsequentialAction: true, evidenceRefs: [], assumptions: [],
          consequences: [{ dimension: 'availability', direction: 'risk' as const, magnitude: 'major' as const, likelihood: 'likely' as const, rationale: 'Interrupts healthy traffic.' }],
        },
      ],
      predictions: [{ alternativeId: 'retry', expectation: 'The operation recovers.', observable: 'successful operation', horizon: 'next attempt', confidence: 'high' as const }],
    },
  }
}

describe('engineering decision analysis capability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    inMock.mockResolvedValue({ data: [{ id: 'artifact-1' }], error: null })
  })

  it('fails closed without workspace scope', async () => {
    const result = await engineeringDecisionAnalysisCapability.execute(args(), context(null))
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.failure.code).toBe('invalid_scope')
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('verifies every evidence id inside the active workspace before reasoning', async () => {
    const result = await engineeringDecisionAnalysisCapability.execute(args(), context('workspace-1'))
    expect(fromMock).toHaveBeenCalledWith('engineering_artifacts')
    expect(eqMock).toHaveBeenCalledWith('workspace_id', 'workspace-1')
    expect(inMock).toHaveBeenCalledWith('id', ['artifact-1'])
    expect(result.status).toBe('inferred')
    if (result.status !== 'failed') expect(result.evidence).toEqual([{ kind: 'artifact', id: 'artifact-1' }])
  })

  it('rejects evidence that does not resolve in the active workspace', async () => {
    inMock.mockResolvedValue({ data: [], error: null })
    const result = await engineeringDecisionAnalysisCapability.execute(args('artifact-other-workspace'), context('workspace-1'))
    expect(result.status).toBe('failed')
    if (result.status === 'failed') {
      expect(result.failure.code).toBe('invalid_args')
      expect(result.failure.message).toContain('not trusted in this workspace')
    }
  })

  it('fails unavailable rather than reasoning over unverifiable evidence', async () => {
    inMock.mockResolvedValue({ data: null, error: { message: 'database down' } })
    const result = await engineeringDecisionAnalysisCapability.execute(args(), context('workspace-1'))
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.failure.code).toBe('unavailable')
  })

  it('refuses cross-workspace outcome comparison', async () => {
    const analyzed = await engineeringDecisionAnalysisCapability.execute(args(), context('workspace-1'))
    expect(analyzed.status).toBe('inferred')
    if (analyzed.status === 'failed') return
    const result = await engineeringDecisionAnalysisCapability.execute({
      mode: 'compare_outcome',
      record: analyzed.data as never,
      outcome: { alternativeId: 'retry', observed: 'Recovered.', evidenceRefs: ['execution-1'], verdict: 'matched', notes: [] },
    }, context('workspace-2'))
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.failure.code).toBe('invalid_scope')
  })
})
