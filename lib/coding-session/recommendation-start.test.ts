import { describe, expect, it } from 'vitest'
import { deriveCanonicalCodingTask } from './recommendation-start'

describe('canonical recommendation coding task', () => {
  it('derives the task from canonical recommendation fields and preserves no-merge boundary', () => {
    const task = deriveCanonicalCodingTask({
      title: 'Improve regression coverage',
      recommendation: 'Add regression tests for the booking race.',
      rationale: 'The canonical evidence shows a repeated booking race.',
    })
    expect(task).toContain('Improve regression coverage')
    expect(task).toContain('Add regression tests for the booking race.')
    expect(task).toContain('The canonical evidence shows a repeated booking race.')
    expect(task).toContain('Do not merge or deploy')
  })
})
