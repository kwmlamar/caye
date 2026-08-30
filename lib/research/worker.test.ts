import { describe, expect, it, vi } from 'vitest'
import { runNextResearchJob } from './worker'

const provider = {
  name: 'test-search',
  search: vi.fn(),
  fetch: vi.fn(),
}

const synthesize = vi.fn()

function dependencies(overrides: Partial<Parameters<typeof runNextResearchJob>[1]> = {}) {
  return {
    claimRun: vi.fn().mockResolvedValue({ id: 'run-1', question_id: 'question-1' }),
    loadQuestion: vi.fn().mockResolvedValue({ id: 'question-1', question: 'What is true?', status: 'open' }),
    executeRun: vi.fn().mockResolvedValue({ status: 'completed', sourceCount: 2, revision: 3 }),
    failRun: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as NonNullable<Parameters<typeof runNextResearchJob>[1]>
}

describe('research worker', () => {
  it('returns idle without touching execution when no run can be claimed', async () => {
    const deps = dependencies({ claimRun: vi.fn().mockResolvedValue(null) })

    const result = await runNextResearchJob({ workerId: 'worker-a', provider, synthesize }, deps)

    expect(result).toEqual({ status: 'idle' })
    expect(deps.loadQuestion).not.toHaveBeenCalled()
    expect(deps.executeRun).not.toHaveBeenCalled()
  })

  it('executes the canonical question associated with the claimed run', async () => {
    const deps = dependencies()

    const result = await runNextResearchJob({ workerId: ' worker-a ', provider, synthesize }, deps)

    expect(deps.claimRun).toHaveBeenCalledWith('worker-a')
    expect(deps.loadQuestion).toHaveBeenCalledWith('question-1')
    expect(deps.executeRun).toHaveBeenCalledWith({
      runId: 'run-1',
      questionId: 'question-1',
      question: 'What is true?',
      provider,
      synthesize,
    })
    expect(result).toMatchObject({ status: 'completed', runId: 'run-1', sourceCount: 2, revision: 3 })
    expect(deps.failRun).not.toHaveBeenCalled()
  })

  it('marks a claimed run failed when canonical question resolution fails', async () => {
    const deps = dependencies({ loadQuestion: vi.fn().mockRejectedValue(new Error('Research question is unavailable')) })

    const result = await runNextResearchJob({ workerId: 'worker-a', provider, synthesize }, deps)

    expect(deps.executeRun).not.toHaveBeenCalled()
    expect(deps.failRun).toHaveBeenCalledWith('run-1', 'Research question is unavailable', 'test-search')
    expect(result).toEqual({ status: 'failed', runId: 'run-1', error: 'Research question is unavailable' })
  })

  it('does not claim work for an empty worker id', async () => {
    const deps = dependencies()

    await expect(runNextResearchJob({ workerId: '   ', provider, synthesize }, deps)).rejects.toThrow('workerId is required')
    expect(deps.claimRun).not.toHaveBeenCalled()
  })
})
