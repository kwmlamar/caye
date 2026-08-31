import { describe, expect, it } from 'vitest'
import { MAX_FOUNDER_DIRECT_TOOLS, selectFounderToolNames } from './founder-tool-selector'

vi.mock('server-only', () => ({}))

import { vi } from 'vitest'

describe('Founder Direct tool manifest selection', () => {
  it('stays below provider tool limits', () => {
    expect(selectFounderToolNames('help me run the business').length).toBeLessThanOrEqual(MAX_FOUNDER_DIRECT_TOOLS)
    expect(MAX_FOUNDER_DIRECT_TOOLS).toBeLessThan(128)
  })

  it('keeps job-autonomy tools visible for a job application request', () => {
    const names = selectFounderToolNames('Start applying for jobs for me. Up to 150 qualified applications per day.')
    expect(names).toContain('start_job_applications')
    expect(names.some((name) => /job|application/i.test(name))).toBe(true)
  })

  it.each([
    'Caye, look into this for me.',
    'I heard NVIDIA bought Hugging Face. Investigate that.',
    'Research whether this matters for Caye.',
    'Keep an eye on this.',
  ])('keeps canonical research creation visible for founder language: %s', (message) => {
    expect(selectFounderToolNames(message)).toContain('start_canonical_research')
  })
})
