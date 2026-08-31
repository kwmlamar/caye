import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ buildStrategicResearchSnapshot: vi.fn() }))
vi.mock('@/lib/strategic-intelligence/snapshot', () => ({ buildStrategicResearchSnapshot: mocks.buildStrategicResearchSnapshot }))
vi.mock('server-only', () => ({}))

import { researchStrategicCapability } from './research-strategic'

const founder = { actor:{kind:'founder' as const,userId:'founder-1'}, scope:{workspaceId:null}, caller:'external_reasoner' as const }

describe('research.strategic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildStrategicResearchSnapshot.mockResolvedValue({
      generatedAt: '2026-08-31T00:00:00Z', whatChanged: [], strongestBeliefs: [], whatYouShouldKnow: [],
      whatYouMightBeMissing: [], opportunities: [], threatsAndChangedAssumptions: [], recommendedNextActions: [],
      stillInvestigating: [], changedMindRecently: [], evidenceWouldChangeRecommendations: [],
    })
  })

  it('is a read-only inferred projection, not an execution claim', async () => {
    const result = await researchStrategicCapability.execute({}, founder)
    expect(result.status).toBe('inferred')
    expect(result.executionRef).toBeNull()
    expect(result.data).not.toBeNull()
  })

  it('fails closed when canonical research cannot be read', async () => {
    mocks.buildStrategicResearchSnapshot.mockRejectedValue(new Error('database unavailable'))
    const result = await researchStrategicCapability.execute({}, founder)
    expect(result.status).toBe('failed')
    expect(result.failure?.code).toBe('unavailable')
    expect(result.executionRef).toBeNull()
  })
})
