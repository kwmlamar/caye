import { describe, it, expect } from 'vitest'
import { validateClassification } from './schema'

describe('validateClassification', () => {
  it('accepts a well-formed not-learnable result', () => {
    const res = validateClassification({ learnable: false, rationale: 'operational instruction only, not durable' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.learnable).toBe(false)
      expect(res.value.destination).toBe('none')
    }
  })

  it('accepts a well-formed business_fact classification', () => {
    const res = validateClassification({
      learnable: true,
      explicitness: 'explicit_correction',
      scope: { kind: 'standing', target: 'workspace', serviceName: null, dateISO: null },
      risk: 'low',
      destination: 'business_fact',
      canonicalKey: 'payment-method',
      confidence: 0.9,
      rationale: 'owner stated payment policy',
      businessFact: { category: 'policy', text: 'We only use online payment.' },
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.businessFact?.text).toBe('We only use online payment.')
  })

  it('rejects a completely malformed payload (not an object)', () => {
    expect(validateClassification('not json').ok).toBe(false)
    expect(validateClassification(null).ok).toBe(false)
    expect(validateClassification(undefined).ok).toBe(false)
  })

  it('rejects missing learnable', () => {
    expect(validateClassification({}).ok).toBe(false)
  })

  it('rejects an invalid explicitness enum value', () => {
    const res = validateClassification({
      learnable: true,
      explicitness: 'super_duper_sure',
      scope: { kind: 'standing', target: 'workspace' },
      risk: 'low',
      destination: 'business_fact',
      canonicalKey: 'x',
      businessFact: { category: 'policy', text: 'x'.repeat(10) },
    })
    expect(res.ok).toBe(false)
  })

  it('rejects a routable destination with no canonicalKey', () => {
    const res = validateClassification({
      learnable: true,
      explicitness: 'explicit_statement',
      scope: { kind: 'standing', target: 'workspace' },
      risk: 'low',
      destination: 'business_fact',
      canonicalKey: null,
      businessFact: { category: 'policy', text: 'x'.repeat(10) },
    })
    expect(res.ok).toBe(false)
  })

  it('rejects destination=specific_date scope with no dateISO', () => {
    const res = validateClassification({
      learnable: true,
      explicitness: 'explicit_correction',
      scope: { kind: 'date_scoped', target: 'specific_date', dateISO: null },
      risk: 'low',
      destination: 'availability_date',
      canonicalKey: 'x',
      availabilityDate: {
        serviceName: 'Full Bimini Experience',
        dateISO: '2026-09-05',
        effect: 'variant_only',
        restrictedVariant: 'private',
      },
    })
    expect(res.ok).toBe(false)
  })

  it('rejects destination=business_fact with too-short fact text', () => {
    const res = validateClassification({
      learnable: true,
      explicitness: 'explicit_statement',
      scope: { kind: 'standing', target: 'workspace' },
      risk: 'low',
      destination: 'business_fact',
      canonicalKey: 'x',
      businessFact: { category: 'policy', text: 'ok' },
    })
    expect(res.ok).toBe(false)
  })

  it('rejects destination=pricing missing priceAmount', () => {
    const res = validateClassification({
      learnable: true,
      explicitness: 'explicit_correction',
      scope: { kind: 'standing', target: 'service', serviceName: 'Full Bimini' },
      risk: 'low',
      destination: 'pricing',
      canonicalKey: 'x',
      pricing: { serviceName: 'Full Bimini', variant: 'shared', isFlat: false },
    })
    expect(res.ok).toBe(false)
  })

  it('rejects destination=availability_date effect=variant_only with no restrictedVariant', () => {
    const res = validateClassification({
      learnable: true,
      explicitness: 'explicit_correction',
      scope: { kind: 'date_scoped', target: 'specific_date', dateISO: '2026-09-05' },
      risk: 'low',
      destination: 'availability_date',
      canonicalKey: 'x',
      availabilityDate: { serviceName: 'Full Bimini', dateISO: '2026-09-05', effect: 'variant_only' },
    })
    expect(res.ok).toBe(false)
  })

  it('rejects destination=contact with invalid role', () => {
    const res = validateClassification({
      learnable: true,
      explicitness: 'explicit_statement',
      scope: { kind: 'standing', target: 'person' },
      risk: 'low',
      destination: 'contact',
      canonicalKey: 'x',
      contact: { name: 'Max', phone: '242-473-0233', role: 'guest' },
    })
    expect(res.ok).toBe(false)
  })

  it('clamps confidence into [0,1]', () => {
    const res = validateClassification({
      learnable: true,
      explicitness: 'explicit_statement',
      scope: { kind: 'standing', target: 'workspace' },
      risk: 'low',
      destination: 'business_fact',
      canonicalKey: 'x',
      confidence: 5,
      businessFact: { category: 'policy', text: 'x'.repeat(10) },
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.confidence).toBe(1)
  })
})
