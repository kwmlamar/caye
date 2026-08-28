import { describe, expect, it } from 'vitest'
import { compareMetric, compareMetrics } from './comparison'

describe('engineering project deterministic comparisons', () => {
  it('computes delta and percent error without model arithmetic', () => {
    expect(compareMetric(
      { metricKey: 'captured_rain_gallons', numericValue: 750, unit: 'gallon' },
      { metricKey: 'captured_rain_gallons', numericValue: 825, unit: 'gallon' }
    )).toMatchObject({ delta: 75, percentError: 10, direction: 'above_prediction' })
  })

  it('refuses incompatible units instead of silently converting', () => {
    expect(() => compareMetric(
      { metricKey: 'storage', numericValue: 2000, unit: 'gallon' },
      { metricKey: 'storage', numericValue: 7570, unit: 'liter' }
    )).toThrow(/Unit mismatch/)
  })

  it('reports missing and incompatible outcomes explicitly', () => {
    const result = compareMetrics([
      { metricKey: 'truck_refills_year', numericValue: 4, unit: 'count_per_year' },
      { metricKey: 'storage', numericValue: 3000, unit: 'gallon' },
      { metricKey: 'captured_rain', numericValue: 800, unit: 'gallon' },
    ], [
      { metricKey: 'storage', numericValue: 3000, unit: 'liter' },
      { metricKey: 'captured_rain', numericValue: 760, unit: 'gallon' },
    ])
    expect(result.comparisons).toHaveLength(1)
    expect(result.missingActual).toEqual(['truck_refills_year'])
    expect(result.incompatible[0]?.metricKey).toBe('storage')
  })
})
