import { describe, it, expect } from 'vitest'
import { decideRouting } from './route-decision'
import type { ClassificationResult, Scope } from './schema'

const scope = (over: Partial<Scope> = {}): Scope => ({
  kind: 'standing',
  target: 'workspace',
  serviceName: null,
  dateISO: null,
  ...over,
})

const base = (over: Partial<ClassificationResult> = {}): ClassificationResult => ({
  learnable: true,
  explicitness: 'explicit_correction',
  scope: scope(),
  risk: 'low',
  destination: 'business_fact',
  canonicalKey: 'payment-method',
  confidence: 0.9,
  rationale: 'test',
  businessFact: { category: 'policy', text: 'We only use online payment.' },
  pricing: null,
  contact: null,
  availabilityRecurring: null,
  availabilityDate: null,
  ...over,
})

describe('decideRouting', () => {
  it('writes live: explicit owner policy correction, standing scope, high confidence', () => {
    const plan = decideRouting({ classification: base(), callerRole: 'owner' })
    expect(plan.action).toBe('attempt_write')
  })

  it('writes live: explicit founder correction', () => {
    const plan = decideRouting({ classification: base(), callerRole: 'founder' })
    expect(plan.action).toBe('attempt_write')
  })

  it('never writes for a not-learnable message ("tell Autumn I will call tomorrow")', () => {
    const plan = decideRouting({
      classification: base({ learnable: false, destination: 'none', canonicalKey: null, businessFact: null }),
      callerRole: 'owner',
    })
    expect(plan.action).toBe('no_op')
  })

  it('never writes a one-off discount, even from the owner, even high confidence ("give this guest $90")', () => {
    const plan = decideRouting({
      classification: base({
        destination: 'pricing',
        scope: scope({ kind: 'customer_scoped', target: 'customer' }),
        pricing: { serviceName: 'Shared Tour', tierName: null, variant: 'shared', priceAmount: 90, isFlat: false },
        businessFact: null,
      }),
      callerRole: 'owner',
    })
    expect(plan.action).toBe('no_op')
  })

  it('never writes a pure one-off scope regardless of destination', () => {
    const plan = decideRouting({
      classification: base({ scope: scope({ kind: 'one_off', target: 'unknown' }) }),
      callerRole: 'owner',
    })
    expect(plan.action).toBe('no_op')
  })

  it('holds as candidate on ambiguous scope', () => {
    const plan = decideRouting({
      classification: base({ scope: scope({ kind: 'ambiguous', target: 'unknown' }) }),
      callerRole: 'owner',
    })
    expect(plan.action).toBe('candidate')
  })

  it('reroutes a date-scoped statement to availability_date even if classifier picked business_fact', () => {
    const plan = decideRouting({
      classification: base({
        destination: 'business_fact',
        scope: scope({ kind: 'date_scoped', target: 'specific_date', dateISO: '2026-09-05' }),
        businessFact: { category: 'service_detail', text: 'Only private available Sept 5.' },
        availabilityDate: {
          serviceName: 'Full Bimini Experience',
          dateISO: '2026-09-05',
          effect: 'variant_only',
          minParty: null,
          restrictedVariant: 'private',
          note: null,
        },
      }),
      callerRole: 'owner',
    })
    expect(plan.action).toBe('attempt_write')
    if (plan.action === 'attempt_write') expect(plan.destination).toBe('availability_date')
  })

  it('holds as candidate when date-scoped but the date could not be resolved ("that day" with no bounded context)', () => {
    const plan = decideRouting({
      classification: base({
        destination: 'business_fact',
        scope: scope({ kind: 'date_scoped', target: 'specific_date', dateISO: null }),
        availabilityDate: null,
      }),
      callerRole: 'owner',
    })
    expect(plan.action).toBe('candidate')
  })

  it('never writes an inferred correction, even low risk, even high confidence', () => {
    const plan = decideRouting({
      classification: base({ explicitness: 'inferred_from_action', confidence: 0.99 }),
      callerRole: 'owner',
    })
    expect(plan.action).toBe('candidate')
  })

  it('holds staff-authored corrections as candidates rather than writing live', () => {
    const plan = decideRouting({ classification: base(), callerRole: 'staff' })
    expect(plan.action).toBe('candidate')
  })

  it('holds driver-authored corrections as candidates', () => {
    const plan = decideRouting({ classification: base(), callerRole: 'driver' })
    expect(plan.action).toBe('candidate')
  })

  it('requires a higher confidence bar for consequential risk (refund policy) than low risk', () => {
    const refund = base({
      risk: 'consequential',
      confidence: 0.6,
      businessFact: { category: 'policy', text: 'Weather cancellations get a full refund within 30 business days.' },
    })
    expect(decideRouting({ classification: refund, callerRole: 'owner' }).action).toBe('candidate')

    const confidentRefund = { ...refund, confidence: 0.8 }
    expect(decideRouting({ classification: confidentRefund, callerRole: 'owner' }).action).toBe('attempt_write')
  })

  it('never writes consequential content on confidence alone when scope.target is unresolved ("unknown") — deterministic gate, not a confidence bar', () => {
    const plan = decideRouting({
      classification: base({
        risk: 'consequential',
        confidence: 0.99, // maximum possible confidence
        scope: scope({ kind: 'standing', target: 'unknown' }),
        businessFact: { category: 'policy', text: 'Refunds work differently now.' },
      }),
      callerRole: 'owner',
    })
    expect(plan.action).toBe('candidate')
  })

  it('an explicit, unambiguous pricing correction is low-risk and writes live, not gated as consequential by default', () => {
    const pricing = base({
      destination: 'pricing',
      risk: 'low',
      confidence: 0.85,
      businessFact: null,
      pricing: { serviceName: 'Full Bimini Experience', tierName: null, variant: 'shared', priceAmount: 110, isFlat: false },
    })
    expect(decideRouting({ classification: pricing, callerRole: 'owner' }).action).toBe('attempt_write')
  })

  it('holds as candidate when scope.dateISO and availabilityDate.dateISO disagree (self-inconsistent classifier output)', () => {
    const plan = decideRouting({
      classification: base({
        destination: 'availability_date',
        scope: scope({ kind: 'date_scoped', target: 'specific_date', dateISO: '2026-09-05' }),
        businessFact: null,
        availabilityDate: {
          serviceName: 'Full Bimini Experience',
          dateISO: '2026-09-06', // deliberately different from scope.dateISO
          effect: 'variant_only',
          minParty: null,
          restrictedVariant: 'private',
          note: null,
        },
      }),
      callerRole: 'owner',
    })
    expect(plan.action).toBe('candidate')
  })

  it('candidate, not no_op, when scope/destination shape is internally inconsistent (standing scope but availability_date destination)', () => {
    const plan = decideRouting({
      classification: base({ destination: 'availability_date', scope: scope({ kind: 'standing' }) }),
      callerRole: 'owner',
    })
    expect(plan.action).toBe('candidate')
  })
})
