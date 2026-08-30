import { describe, expect, it } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  calibrationCanonicalKey,
  calibrationCandidateKey,
  classifyCalibration,
  ENGINEERING_OUTCOME_MIN_PROJECTS,
  recommendationForCalibration,
} from './outcome-learning'
import { vi } from 'vitest'

describe('engineering outcome learning calibration', () => {
  it('does not learn from small prediction error', () => {
    expect(classifyCalibration(100, 115)).toEqual({ direction: null, percentError: 15 })
  })

  it('classifies material underprediction and overprediction deterministically', () => {
    expect(classifyCalibration(100, 140).direction).toBe('underpredicted')
    expect(classifyCalibration(100, 60).direction).toBe('overpredicted')
  })

  it('refuses a zero prediction because percentage calibration is undefined', () => {
    expect(classifyCalibration(0, 10)).toEqual({ direction: null, percentError: null })
  })

  it('uses one canonical memory key while keeping opposite candidate directions separate', () => {
    expect(calibrationCanonicalKey('Tank Refill Days', 'days')).toBe('engineering_prediction_calibration:tank refill days:days')
    expect(calibrationCandidateKey('Tank Refill Days', 'days', 'underpredicted')).toBe('engineering_prediction_calibration:tank refill days:days:underpredicted')
    expect(calibrationCandidateKey('Tank Refill Days', 'days', 'overpredicted')).toBe('engineering_prediction_calibration:tank refill days:days:overpredicted')
  })

  it('states the evidence count and advisory boundary in the validated recommendation', () => {
    const text = recommendationForCalibration('tank_refill_days', 'days', 'underpredicted', ENGINEERING_OUTCOME_MIN_PROJECTS)
    expect(text).toContain('across 2 engineering projects')
    expect(text).toContain('guidance, not policy')
    expect(text).toContain('below actual results')
  })
})
