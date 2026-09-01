import { describe, expect, it } from 'vitest'
import { deriveCanonicalCodingTask, startCodingSessionForRecommendation } from './recommendation-start'

describe('canonical recommendation coding boundary', () => {
  it('recognizes that the legacy task formatter produces natural-language prose, not an execution contract', () => {
    const task = deriveCanonicalCodingTask({
      title: 'Improve regression coverage',
      recommendation: 'Add regression tests for the booking race.',
      rationale: 'The canonical evidence shows a repeated booking race.',
    })
    expect(task).toContain('Improve regression coverage')
    expect(task).toContain('Add regression tests for the booking race.')
    expect(task).toContain('The canonical evidence shows a repeated booking race.')
  })

  it('fails closed before arbitrary recommendation prose can launch a coding agent', async () => {
    await expect(startCodingSessionForRecommendation({
      recommendationId: '11111111-1111-1111-1111-111111111111',
      workspaceId: null,
    })).rejects.toThrow(/disabled.*structured coding intent.*bounded recursion/i)
  })
})
