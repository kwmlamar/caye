import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ClassificationResult } from './operator-learning/schema'
import type { WriteOutcome } from './operator-learning/writers/types'

vi.mock('server-only', () => ({}))

// ── classify ────────────────────────────────────────────────────────────
let classifyMock: (text: string) => Promise<{ ok: true; value: ClassificationResult } | { ok: false; reason: string }>
vi.mock('./operator-learning/classify', () => ({
  classifyOperatorMessage: async (args: { operatorText: string }) => classifyMock(args.operatorText),
}))

// ── audit ───────────────────────────────────────────────────────────────
const auditCalls: Record<string, unknown>[] = []
let alreadyProcessedResult = false
vi.mock('./operator-learning/audit', () => ({
  recordLearningAudit: async (input: Record<string, unknown>) => {
    auditCalls.push(input)
  },
  alreadyProcessed: async () => alreadyProcessedResult,
}))

// ── hold ────────────────────────────────────────────────────────────────
const holdBusinessFactCalls: Record<string, unknown>[] = []
const holdGenericCalls: Record<string, unknown>[] = []
vi.mock('./operator-learning/hold', () => ({
  holdBusinessFactCandidate: async (args: Record<string, unknown>) => {
    holdBusinessFactCalls.push(args)
    return { candidateId: 'candidate-1' }
  },
  holdGenericNotice: async (args: Record<string, unknown>) => {
    holdGenericCalls.push(args)
  },
}))

// ── writers ─────────────────────────────────────────────────────────────
const writerCalls: { writer: string; args: Record<string, unknown> }[] = []
let writerOutcome: WriteOutcome = { decision: 'written', targetTable: 't', targetRecordId: 'id-1', supersededRecordId: null, reason: 'ok' }
let writerThrows = false

vi.mock('./operator-learning/writers/business-fact-writer', () => ({
  writeBusinessFact: async (args: Record<string, unknown>) => {
    writerCalls.push({ writer: 'business_fact', args })
    if (writerThrows) throw new Error('writer exploded')
    return writerOutcome
  },
}))
vi.mock('./operator-learning/writers/pricing-writer', () => ({
  writePricing: async (args: Record<string, unknown>) => {
    writerCalls.push({ writer: 'pricing', args })
    if (writerThrows) throw new Error('writer exploded')
    return writerOutcome
  },
}))
vi.mock('./operator-learning/writers/contact-writer', () => ({
  writeContact: async (args: Record<string, unknown>) => {
    writerCalls.push({ writer: 'contact', args })
    if (writerThrows) throw new Error('writer exploded')
    return writerOutcome
  },
}))
vi.mock('./operator-learning/writers/availability-writer', () => ({
  writeAvailabilityRecurring: async (args: Record<string, unknown>) => {
    writerCalls.push({ writer: 'availability_recurring', args })
    if (writerThrows) throw new Error('writer exploded')
    return writerOutcome
  },
  writeAvailabilityDate: async (args: Record<string, unknown>) => {
    writerCalls.push({ writer: 'availability_date', args })
    if (writerThrows) throw new Error('writer exploded')
    return writerOutcome
  },
}))

const { routeOperatorLearningCorrection } = await import('./operator-learning-router')
const { validateClassification } = await import('./operator-learning/schema')

function ok(raw: Record<string, unknown>): { ok: true; value: ClassificationResult } {
  const res = validateClassification(raw)
  if (!res.ok) throw new Error(`bad test fixture classification: ${res.reason}`)
  return { ok: true, value: res.value }
}

const baseInput = {
  workspaceId: 'ws-bimini',
  operatorId: 42,
  operatorRole: 'owner' as const,
  previousCayeText: null,
  sourceMessageId: 'msg-1',
  sourceConversationId: 'operator:42',
}

beforeEach(() => {
  auditCalls.length = 0
  holdBusinessFactCalls.length = 0
  holdGenericCalls.length = 0
  writerCalls.length = 0
  writerOutcome = { decision: 'written', targetTable: 't', targetRecordId: 'id-1', supersededRecordId: null, reason: 'ok' }
  writerThrows = false
  alreadyProcessedResult = false
  classifyMock = async () => {
    throw new Error('classifyMock not configured for this test')
  }
})

function lastAudit() {
  return auditCalls[auditCalls.length - 1] as { decision: string }
}

describe('Bimini production fixtures', () => {
  it('1. bottled water $2.50/guest — writes as a business fact', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_statement',
        scope: { kind: 'standing', target: 'workspace' }, risk: 'low',
        destination: 'business_fact', canonicalKey: 'bottled-water-price', confidence: 0.9,
        rationale: 'owner stated an ancillary fee', businessFact: { category: 'service_detail', text: 'Bottled water is $2.50 per guest, one bottle per person.' },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'Bottled water is $2.50 per guest, one bottle per person.' })
    expect(writerCalls[0].writer).toBe('business_fact')
    expect(lastAudit().decision).toBe('written')
  })

  it('2. online payment only — writes as a policy fact, supersedes the old payment fact', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_correction',
        scope: { kind: 'standing', target: 'workspace' }, risk: 'low',
        destination: 'business_fact', canonicalKey: 'payment-method', confidence: 0.9,
        rationale: 'owner corrected the payment policy', businessFact: { category: 'policy', text: 'We only use online payment.' },
      })
    writerOutcome = { decision: 'superseded_and_written', targetTable: 'business_facts', targetRecordId: 'fact-new', supersededRecordId: 'fact-old', reason: 'superseded' }
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'We only use online payment.' })
    expect(writerCalls[0].writer).toBe('business_fact')
    expect(lastAudit()).toMatchObject({ decision: 'superseded_and_written' })
  })

  it('3. shared tour $110/person — routes to pricing, never prose', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_correction',
        scope: { kind: 'standing', target: 'service', serviceName: 'Full Bimini Experience' }, risk: 'low',
        destination: 'pricing', canonicalKey: 'full-bimini-shared-price', confidence: 0.9,
        rationale: 'owner corrected the shared-tour price',
        pricing: { serviceName: 'Full Bimini Experience', tierName: null, variant: 'shared', priceAmount: 110, isFlat: false },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'The shared tour is $110 per person.' })
    expect(writerCalls[0].writer).toBe('pricing')
    expect(writerCalls.some((c) => c.writer === 'business_fact')).toBe(false)
  })

  it('4. all pickups at Casino Tram Stop — workspace-wide because the wording explicitly says "all"', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_statement',
        scope: { kind: 'standing', target: 'workspace' }, risk: 'low',
        destination: 'business_fact', canonicalKey: 'casino-tram-stop-pickup', confidence: 0.92,
        rationale: 'owner stated pickup applies to all tours', businessFact: { category: 'logistics', text: 'All of our pickup location is at the Casino Tram Stop.' },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'All of our pickup location is at the Casino Tram Stop.' })
    expect(writerCalls[0].writer).toBe('business_fact')
    expect(lastAudit().decision).toBe('written')
  })

  it('5. Max as driver/contact — routes to contact infra, never business_facts prose', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_statement',
        scope: { kind: 'standing', target: 'person' }, risk: 'low',
        destination: 'contact', canonicalKey: 'max-driver-contact', confidence: 0.95,
        rationale: 'owner introduced the driver', contact: { name: 'Max', phone: '242-473-0233', role: 'driver' },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'Max is the driver. His number is 242-473-0233.' })
    expect(writerCalls[0].writer).toBe('contact')
    expect(writerCalls.some((c) => c.writer === 'business_fact')).toBe(false)
  })

  it('6. weather cancellation refund within 30 business days — consequential but explicit+confident, still writes live', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_statement',
        scope: { kind: 'standing', target: 'workspace' }, risk: 'consequential',
        destination: 'business_fact', canonicalKey: 'weather-refund-policy', confidence: 0.8,
        rationale: 'owner stated the weather refund policy', businessFact: { category: 'policy', text: 'If the tour is cancelled due to weather, guests receive a full refund within 30 business days.' },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'If weather cancels the tour, they get a full refund within 30 business days.' })
    expect(writerCalls[0].writer).toBe('business_fact')
    expect(lastAudit().decision).toBe('written')
  })

  it('6b. the same refund policy at LOW confidence is held as a candidate, not written', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_statement',
        scope: { kind: 'standing', target: 'workspace' }, risk: 'consequential',
        destination: 'business_fact', canonicalKey: 'weather-refund-policy', confidence: 0.6,
        rationale: 'unclear phrasing', businessFact: { category: 'policy', text: 'Something about weather refunds maybe.' },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'something vague about weather refunds' })
    expect(writerCalls).toHaveLength(0)
    expect(holdBusinessFactCalls).toHaveLength(1)
    expect(lastAudit().decision).toBe('candidate')
  })

  it('7. private-only availability for Sept 5 — routes to the date-scoped override, not a standing fact', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_statement',
        scope: { kind: 'date_scoped', target: 'specific_date', dateISO: '2026-09-05' }, risk: 'low',
        destination: 'availability_date', canonicalKey: 'full-bimini-2026-09-05', confidence: 0.9,
        rationale: 'owner stated a one-date restriction',
        availabilityDate: { serviceName: 'Full Bimini Experience', dateISO: '2026-09-05', effect: 'variant_only', restrictedVariant: 'private' },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'Only private tours are available on September 5.' })
    expect(writerCalls[0].writer).toBe('availability_date')
    expect(writerCalls.some((c) => c.writer === 'business_fact')).toBe(false)
    expect(lastAudit().decision).toBe('written')
  })

  it('8. "give this guest the shared tour for $90" — one-off/customer-scoped, no global pricing mutation', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_statement',
        scope: { kind: 'customer_scoped', target: 'customer' }, risk: 'low',
        destination: 'pricing', canonicalKey: 'full-bimini-shared-price', confidence: 0.9,
        rationale: 'a one-off discount for one guest',
        pricing: { serviceName: 'Full Bimini Experience', tierName: null, variant: 'shared', priceAmount: 90, isFlat: false },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'Give this guest the shared tour for $90.' })
    expect(writerCalls).toHaveLength(0)
    expect(holdGenericCalls).toHaveLength(0) // customer-scoped never even becomes a "should this be global?" candidate
    expect(lastAudit().decision).toBe('no_op')
  })

  it('9. "No Zelle, online payment only" — same canonical key as fixture 2, still writes', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_correction',
        scope: { kind: 'standing', target: 'workspace' }, risk: 'low',
        destination: 'business_fact', canonicalKey: 'payment-method', confidence: 0.92,
        rationale: 'owner corrected payment method again', businessFact: { category: 'policy', text: 'We do not accept Zelle — online payment only.' },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'No Zelle, online payment only.' })
    expect(writerCalls[0].writer).toBe('business_fact')
    expect(lastAudit().decision).toBe('written')
  })

  it('10. "Tell Autumn I\'ll call her tomorrow" — pure operational instruction, no durable learning', async () => {
    classifyMock = async () => ok({ learnable: false, rationale: 'one-off operational instruction, not durable' })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: "Tell Autumn I'll call her tomorrow." })
    expect(writerCalls).toHaveLength(0)
    expect(holdGenericCalls).toHaveLength(0)
    expect(holdBusinessFactCalls).toHaveLength(0)
    expect(lastAudit().decision).toBe('no_op')
  })

  it('11a. "only private available that day" WITH a resolvable date — writes the date-scoped override', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_statement',
        // Classifier reached for business_fact first — router must reroute
        // to availability_date because the date-scoped payload is present.
        scope: { kind: 'date_scoped', target: 'specific_date', dateISO: '2026-09-05' }, risk: 'low',
        destination: 'business_fact', canonicalKey: 'full-bimini-2026-09-05', confidence: 0.9,
        rationale: 'date was anchored earlier in the thread',
        businessFact: { category: 'service_detail', text: 'Only private available Sept 5.' },
        availabilityDate: { serviceName: 'Full Bimini Experience', dateISO: '2026-09-05', effect: 'variant_only', restrictedVariant: 'private' },
      })
    await routeOperatorLearningCorrection({
      ...baseInput,
      operatorText: 'We only have private available that day.',
      previousCayeText: 'Just confirming — this is for September 5th, correct?',
    })
    expect(writerCalls[0].writer).toBe('availability_date')
    expect(writerCalls.some((c) => c.writer === 'business_fact')).toBe(false)
  })

  it('11b. "only private available that day" WITHOUT resolvable date context — holds as candidate, never a standing fact', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_statement',
        scope: { kind: 'date_scoped', target: 'unknown', dateISO: null }, risk: 'low',
        // No prior date was anchored anywhere in bounded context, so the
        // classifier cannot honestly claim destination: availability_date
        // (which requires a resolved dateISO) — it falls back to its next
        // best guess. route-decision's date_scoped branch holds this as a
        // candidate regardless of which destination was guessed, because
        // no availabilityDate payload is present to reroute onto.
        destination: 'business_fact', canonicalKey: 'unknown-date-private-only', confidence: 0.6,
        rationale: 'date-scoped but no date is resolvable from bounded context',
        businessFact: { category: 'service_detail', text: 'Only private available that day (date not resolvable).' },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'We only have private available that day.' })
    expect(writerCalls).toHaveLength(0)
    expect(lastAudit().decision).toBe('candidate')
  })

  it('12. cruise guests take the complimentary tram to the Casino Tram Stop — procedure routes to the existing business-knowledge path', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_statement',
        scope: { kind: 'standing', target: 'workspace' }, risk: 'low',
        destination: 'business_fact', canonicalKey: 'cruise-guest-tram-procedure', confidence: 0.88,
        rationale: 'owner stated a standing procedure',
        businessFact: { category: 'logistics', text: 'Cruise guests should take the complimentary Resorts World Bimini tram to the Casino Tram Stop.' },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'Cruise guests should take the complimentary tram to the Casino Tram Stop.' })
    expect(writerCalls[0].writer).toBe('business_fact')
    expect(lastAudit().decision).toBe('written')
  })

  it('13. "make pickup explanation easy and reassuring" — operational preference, no dedicated store, falls to the business-facts escape hatch', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_statement',
        scope: { kind: 'standing', target: 'workspace' }, risk: 'low',
        destination: 'business_fact', canonicalKey: 'pickup-tone-preference', confidence: 0.7,
        rationale: 'owner stated a presentation preference, not a fact — no dedicated preference store exists',
        businessFact: { category: 'special_handling', text: 'When describing pickup, keep it easy and reassuring for the guest.' },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'When you explain pickup, make it feel easy and reassuring.' })
    expect(writerCalls[0].writer).toBe('business_fact')
  })
})

describe('adversarial cases', () => {
  it('duplicate webhook delivery: classifier is never called a second time, no second write', async () => {
    alreadyProcessedResult = true
    classifyMock = async () => {
      throw new Error('classifier should never be reached for an already-processed message')
    }
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'We only use online payment.' })
    expect(writerCalls).toHaveLength(0)
    expect(auditCalls).toHaveLength(0) // idempotency check short-circuits before any audit row too
  })

  it('same correction paraphrased twice: both processed independently, writer called both times (DB-level chaining tested at the migration layer)', async () => {
    classifyMock = async (text) =>
      ok({
        learnable: true, explicitness: 'explicit_correction',
        scope: { kind: 'standing', target: 'workspace' }, risk: 'low',
        destination: 'business_fact', canonicalKey: 'payment-method', confidence: 0.9,
        rationale: 'owner restated the payment policy', businessFact: { category: 'policy', text },
      })
    await routeOperatorLearningCorrection({ ...baseInput, sourceMessageId: 'msg-a', operatorText: 'We only use online payment.' })
    await routeOperatorLearningCorrection({ ...baseInput, sourceMessageId: 'msg-b', operatorText: 'Just to be clear, online payment only from now on.' })
    expect(writerCalls).toHaveLength(2)
    expect(writerCalls.every((c) => c.writer === 'business_fact')).toBe(true)
  })

  it('contradictory owner/founder corrections in sequence: each is audited with its own decision', async () => {
    let call = 0
    classifyMock = async (text) => {
      call += 1
      return ok({
        learnable: true, explicitness: 'explicit_correction',
        scope: { kind: 'standing', target: 'workspace' }, risk: 'low',
        destination: 'business_fact', canonicalKey: 'payment-method', confidence: 0.9,
        rationale: 'correction', businessFact: { category: 'policy', text },
      })
    }
    writerOutcome = { decision: 'written', targetTable: 'business_facts', targetRecordId: 'f1', supersededRecordId: null, reason: 'ok' }
    await routeOperatorLearningCorrection({ ...baseInput, sourceMessageId: 'm1', operatorText: 'We only use online payment.' })
    writerOutcome = { decision: 'superseded_and_written', targetTable: 'business_facts', targetRecordId: 'f2', supersededRecordId: 'f1', reason: 'ok' }
    await routeOperatorLearningCorrection({ ...baseInput, sourceMessageId: 'm2', operatorRole: 'founder', operatorText: 'Actually cash is fine too.' })
    expect(auditCalls).toHaveLength(2)
    expect(auditCalls[0]).toMatchObject({ decision: 'written' })
    expect(auditCalls[1]).toMatchObject({ decision: 'superseded_and_written', supersededRecordId: 'f1' })
  })

  it('staff-authored correction: classified, held as candidate, never written live under current authority policy', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_correction',
        scope: { kind: 'standing', target: 'workspace' }, risk: 'low',
        destination: 'business_fact', canonicalKey: 'payment-method', confidence: 0.95,
        rationale: 'staff stated a policy correction', businessFact: { category: 'policy', text: 'We only use online payment.' },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorRole: 'staff', operatorText: 'We only use online payment.' })
    expect(writerCalls).toHaveLength(0)
    expect(holdBusinessFactCalls).toHaveLength(1)
    expect(lastAudit()).toMatchObject({ decision: 'candidate' })
  })

  it('no resolved operator id (structurally, the only way a non-operator sender could reach this function): no_op, classifier never called', async () => {
    classifyMock = async () => {
      throw new Error('should never classify without a resolved operator')
    }
    await routeOperatorLearningCorrection({ ...baseInput, operatorId: null, operatorText: 'We only use online payment.' })
    expect(writerCalls).toHaveLength(0)
    expect(lastAudit().decision).toBe('no_op')
  })

  it('malformed classifier output: audited as error, nothing written', async () => {
    classifyMock = async () => ({ ok: false, reason: 'schema validation failed: invalid destination' })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'We only use online payment.' })
    expect(writerCalls).toHaveLength(0)
    expect(lastAudit().decision).toBe('error')
  })

  it('classifier timeout/failure: audited as error, operator turn is never blocked (no throw escapes this function)', async () => {
    classifyMock = async () => ({ ok: false, reason: 'classifier call failed: timeout after 30000ms' })
    await expect(
      routeOperatorLearningCorrection({ ...baseInput, operatorText: 'We only use online payment.' })
    ).resolves.toBeUndefined()
    expect(lastAudit().decision).toBe('error')
  })

  it('writer throws (e.g. unexpected DB exception): caught, audited as error, function does not throw', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_statement',
        scope: { kind: 'standing', target: 'workspace' }, risk: 'low',
        destination: 'business_fact', canonicalKey: 'bottled-water-price', confidence: 0.9,
        rationale: 'x', businessFact: { category: 'service_detail', text: 'Bottled water is $2.50 per guest.' },
      })
    writerThrows = true
    await expect(
      routeOperatorLearningCorrection({ ...baseInput, operatorText: 'Bottled water is $2.50 per guest.' })
    ).resolves.toBeUndefined()
    expect(lastAudit().decision).toBe('error')
  })

  it('writer itself downgrades to candidate (e.g. ambiguous service resolution): router surfaces it as a hold, not a silent failure', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_correction',
        scope: { kind: 'standing', target: 'service', serviceName: 'Full Bimini' }, risk: 'low',
        destination: 'pricing', canonicalKey: 'full-bimini-shared-price', confidence: 0.9,
        rationale: 'x', pricing: { serviceName: 'Full Bimini', tierName: null, variant: 'shared', priceAmount: 110, isFlat: false },
      })
    writerOutcome = { decision: 'candidate', reason: 'multiple services matched "Full Bimini" — could not resolve unambiguously' }
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'Full Bimini shared is $110.' })
    expect(holdGenericCalls).toHaveLength(1)
    expect(lastAudit()).toMatchObject({ decision: 'candidate' })
  })

  it('destination dispatch correctness: a contact classification never reaches the business-fact writer', async () => {
    classifyMock = async () =>
      ok({
        learnable: true, explicitness: 'explicit_statement',
        scope: { kind: 'standing', target: 'person' }, risk: 'low',
        destination: 'contact', canonicalKey: 'max-driver-contact', confidence: 0.9,
        rationale: 'x', contact: { name: 'Max', phone: '242-473-0233', role: 'driver' },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'Max drives for us, 242-473-0233.' })
    expect(writerCalls).toEqual([{ writer: 'contact', args: expect.anything() }])
  })
})
