import { describe, expect, it } from 'vitest'
import { findPrimaryBottleneck, metric } from './outcome-model'

describe('Direction outcome model', () => {
  it('selects the weakest comparable current funnel transition without a benchmark', () => {
    const result = findPrimaryBottleneck([
      { label: 'qualified jobs', value: 100 },
      { label: 'prepared jobs', value: 60 },
      { label: 'verified submission', value: 18 },
      { label: 'responses', value: 8 },
    ])
    expect(result).toEqual(expect.objectContaining({ from: 'prepared jobs', to: 'verified submission', numerator: 18, denominator: 60, conversion: 0.3 }))
    expect(result?.statement).toBe('Only 30% of prepared jobs currently reach verified submission.')
  })

  it('fails closed when a downstream metric is unavailable', () => {
    expect(findPrimaryBottleneck([{ label: 'responses', value: 8 }, { label: 'screens', value: null }])).toBeNull()
  })

  it('does not compare inconsistent non-cumulative stage counts', () => {
    expect(findPrimaryBottleneck([{ label: 'contacted', value: 5 }, { label: 'replies', value: 8 }])).toBeNull()
  })

  it('preserves unknown revenue values instead of converting them to zero', () => {
    expect(metric('mrr', 'MRR', null, 'insufficient evidence', 'usd_monthly').value).toBeNull()
  })
})
