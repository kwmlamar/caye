import { describe, expect, it } from 'vitest'
import { validateGrowthDiagnosis } from './diagnosis-contract'

describe('validateGrowthDiagnosis', () => {
  it('rejects disconnected analytics disguised as zero', () => {
    expect(validateGrowthDiagnosis({
      diagnosisKey: 'traffic_low',
      headline: 'Traffic is low',
      explanation: 'bad inference',
      confidence: 0.9,
      evidence: [{ observationId: 'ga4', metricKey: 'sessions', value: 0, observedAt: new Date().toISOString(), state: 'unavailable', unavailableReason: 'disconnected' }],
      missingSources: ['ga4'],
    })).toEqual({ ok: false, reason: 'unavailable_evidence_must_be_null_and_explained' })
  })

  it('requires real observed evidence before diagnosis', () => {
    expect(validateGrowthDiagnosis({
      diagnosisKey: 'traffic_low', headline: 'Traffic is low', explanation: 'unknown', confidence: 0.2,
      evidence: [{ observationId: 'ga4', metricKey: 'sessions', value: null, observedAt: new Date().toISOString(), state: 'unavailable', unavailableReason: 'disconnected' }],
      missingSources: ['ga4'],
    })).toEqual({ ok: false, reason: 'no_observed_evidence' })
  })

  it('accepts an evidence-backed diagnosis while preserving missing sources', () => {
    expect(validateGrowthDiagnosis({
      diagnosisKey: 'conversion_weak', headline: 'Conversion is weak', explanation: 'Bookings lag sessions', confidence: 0.7,
      evidence: [{ observationId: 'obs-1', metricKey: 'booking_conversion_rate', value: 0.01, observedAt: new Date().toISOString(), state: 'observed' }],
      missingSources: ['search_console'],
    })).toEqual({ ok: true })
  })
})
