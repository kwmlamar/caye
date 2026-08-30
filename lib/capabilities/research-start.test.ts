import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ queueResearchRun: vi.fn() }))
vi.mock('@/lib/research/runtime', () => ({ queueResearchRun: mocks.queueResearchRun }))
vi.mock('server-only', () => ({}))

import { researchStartCapability } from './research-start'

const founder = { actor:{kind:'founder' as const,userId:'founder-1'}, scope:{workspaceId:null}, caller:'external_reasoner' as const }

describe('research.start', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.queueResearchRun.mockResolvedValue({id:'run-1',question_id:'question-1',status:'queued',created_at:'2026-08-30T00:00:00Z'}) })

  it('stages durable research without claiming execution', async () => {
    const result = await researchStartCapability.execute({questionId:'question-1'}, founder)
    expect(mocks.queueResearchRun).toHaveBeenCalledWith('question-1','founder')
    expect(result.status).toBe('staged')
    expect(result.executionRef).toBeNull()
    expect(result.auditRef).toBe('research_run:run-1')
  })

  it('refuses customer-workspace scope', async () => {
    const result = await researchStartCapability.execute({questionId:'question-1'},{...founder,scope:{workspaceId:'customer-workspace'}})
    expect(result.status).toBe('failed')
    expect(result.failure?.code).toBe('invalid_scope')
    expect(mocks.queueResearchRun).not.toHaveBeenCalled()
  })

  it('refuses missing question ids', async () => {
    const result = await researchStartCapability.execute({questionId:'   '}, founder)
    expect(result.status).toBe('failed')
    expect(result.failure?.code).toBe('invalid_args')
    expect(mocks.queueResearchRun).not.toHaveBeenCalled()
  })

  it('reports queue failures without pretending work was staged', async () => {
    mocks.queueResearchRun.mockRejectedValue(new Error('database unavailable'))
    const result = await researchStartCapability.execute({questionId:'question-1'}, founder)
    expect(result.status).toBe('failed')
    expect(result.executionRef).toBeNull()
    expect(result.failure?.message).toContain('database unavailable')
  })
})
