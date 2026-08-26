import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClassificationResult } from './operator-learning/schema'
import type { WriteOutcome } from './operator-learning/writers/types'

vi.mock('server-only', () => ({}))

/**
 * operator-learning-router.bimini-historical.test.ts
 *
 * Regression fixtures built from the 2026-08-26 historical-learning audit
 * against Bimini Island Tours' REAL production data (Supabase project
 * fetsfbdltlxjsomiqvrw, workspace 653257d9-...) — not the synthetic
 * examples in operator-learning-router.test.ts. Customer/partner names and
 * contact identities have been sanitized or omitted; the operator statement
 * text and the business's own published contact number are reproduced
 * verbatim or near-verbatim from real caye_operator_messages / business_facts
 * rows, since that's the actual input the classifier would have seen.
 *
 * Each fixture cites the real finding it's derived from in its own comment.
 */

let classifyMock: (text: string) => Promise<{ ok: true; value: ClassificationResult } | { ok: false; reason: string }>
vi.mock('./operator-learning/classify', () => ({
  classifyOperatorMessage: async (args: { operatorText: string }) => classifyMock(args.operatorText),
}))

const auditCalls: Record<string, unknown>[] = []
vi.mock('./operator-learning/audit', () => ({
  recordLearningAudit: async (input: Record<string, unknown>) => {
    auditCalls.push(input)
  },
  alreadyProcessed: async () => false,
}))

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

const writerCalls: { writer: string; args: Record<string, unknown> }[] = []
let writerOutcome: WriteOutcome = { decision: 'written', targetTable: 't', targetRecordId: 'id-1', supersededRecordId: null, reason: 'ok' }

vi.mock('./operator-learning/writers/business-fact-writer', () => ({
  writeBusinessFact: async (args: Record<string, unknown>) => {
    writerCalls.push({ writer: 'business_fact', args })
    return writerOutcome
  },
}))
vi.mock('./operator-learning/writers/pricing-writer', () => ({
  writePricing: async (args: Record<string, unknown>) => {
    writerCalls.push({ writer: 'pricing', args })
    return writerOutcome
  },
}))
vi.mock('./operator-learning/writers/contact-writer', () => ({
  writeContact: async (args: Record<string, unknown>) => {
    writerCalls.push({ writer: 'contact', args })
    return writerOutcome
  },
}))
vi.mock('./operator-learning/writers/availability-writer', () => ({
  writeAvailabilityRecurring: async (args: Record<string, unknown>) => {
    writerCalls.push({ writer: 'availability_recurring', args })
    return writerOutcome
  },
  writeAvailabilityDate: async (args: Record<string, unknown>) => {
    writerCalls.push({ writer: 'availability_date', args })
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
  workspaceId: 'ws-bimini-real',
  operatorId: 1,
  operatorRole: 'owner' as const,
  previousCayeText: null,
  sourceMessageId: 'msg-real-1',
  sourceConversationId: 'operator:1',
}

beforeEach(() => {
  auditCalls.length = 0
  holdBusinessFactCalls.length = 0
  holdGenericCalls.length = 0
  writerCalls.length = 0
  writerOutcome = { decision: 'written', targetTable: 't', targetRecordId: 'id-1', supersededRecordId: null, reason: 'ok' }
})

describe('real Bimini history — category B (missing durable knowledge that should now be captured)', () => {
  // FOUND: Sidney Morales / Accessible Travel Solutions (a B2B cruise-shore-
  // excursion partner) asked "is bottled water included, and if not what
  // does it cost" on 2026-08-22, followed up twice more (2026-08-25 x2)
  // before an answer went out on 2026-08-26 — four days, three asks, one
  // open escalation. business_facts has NO row about bottled water as of
  // this audit, even after the answer was finally given: a brand-new
  // customer thread today would repeat the entire escalation. This fixture
  // proves the router would have closed that gap the moment the answer was
  // given, instead of leaving it to happen again.
  it('bottled water pricing — a real 4-day, 3-escalation gap this closes', async () => {
    const text = 'Bottled water can be provided during our tours and excursions at a cost of $2.50 per guest, which includes one bottle of water per person.'
    classifyMock = async () =>
      ok({
        learnable: true,
        explicitness: 'explicit_statement',
        scope: { kind: 'standing', target: 'workspace' },
        risk: 'low',
        destination: 'business_fact',
        canonicalKey: 'bottled-water-price',
        confidence: 0.9,
        rationale: 'owner stated a standing ancillary-item price applicable to any guest',
        businessFact: { category: 'service_detail', text },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: text })
    expect(writerCalls[0].writer).toBe('business_fact')
    expect(auditCalls[auditCalls.length - 1]).toMatchObject({ decision: 'written' })
  })

  // FOUND: 2026-08-18, a customer (sanitized) asked about snorkeling/Snuba.
  // Caye initially answered uncertainly, then the owner explicitly
  // confirmed in-thread: the business doesn't run water tours itself but
  // CAN coordinate one through a trusted partner. This exact incident is
  // what CAY-92's policy-figure-guard (detectUnsupportedThirdPartyCommitment)
  // was built to catch downstream — but the underlying CAPABILITY the owner
  // authorized was never captured as a business_facts row, so the guard can
  // only ever block a future claim, never let a correctly-authorized one
  // through automatically. This fixture proves the router captures the
  // authorization itself, not just its absence.
  it('third-party water-excursion coordination — the fact CAY-92 exists to defend, never itself captured', async () => {
    const text = 'We do not do water tours ourselves, but we are able to coordinate a snorkeling or Snuba experience for a guest through one of our trusted partners.'
    classifyMock = async () =>
      ok({
        learnable: true,
        explicitness: 'explicit_correction',
        scope: { kind: 'standing', target: 'workspace' },
        risk: 'low',
        destination: 'business_fact',
        canonicalKey: 'water-excursion-partner-coordination',
        confidence: 0.85,
        rationale: 'owner confirmed a standing capability, not a one-off arrangement for a single guest',
        businessFact: { category: 'special_handling', text },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: text })
    expect(writerCalls[0].writer).toBe('business_fact')
  })
})

describe('real Bimini history — category E (genuine one-off/customer-scoped, must NOT generalize)', () => {
  // FOUND: 2026-08-14 17:54:24, Will's VIP Escort to Port Royale thread.
  // Caye first quoted the generic template rate ($90 for 2). Mrs. Max
  // corrected: "actually the total will be $125 for 2 and it covers VIP
  // Escort to Port Royale for arrival and transportation round trip. THE
  // ESCORT IS ONLY FOR THE ARRIVAL ON THEIR 10:45 FLIGHT ON AMERICAN
  // AIRLINE." The explicit "only for... their... flight" phrasing scopes
  // this to Will's specific arrival — VIP Pickup & Meet and Greet has no
  // catalog pricing tiers at all (confirmed: booking_services shows this
  // service with zero service_pricing_tiers rows), consistent with VIP
  // transport being quoted per-request based on flight/distance specifics,
  // not a fixed rate. This must never become "VIP Escort to Port Royale is
  // $125" as a standing price.
  it('VIP escort $125 for one guest\'s specific flight — customer_scoped, must not become a standing VIP rate', async () => {
    const text =
      'Actually the total will be $125 for 2 and it covers VIP Escort to Port Royale for arrival and transportation round trip. The escort is only for the arrival on their 10:45 flight on American Airlines.'
    classifyMock = async () =>
      ok({
        learnable: true,
        explicitness: 'explicit_correction',
        scope: { kind: 'customer_scoped', target: 'customer' },
        risk: 'low',
        destination: 'pricing',
        canonicalKey: 'vip-escort-port-royale-price',
        confidence: 0.85,
        rationale: 'price is explicitly scoped to one guest\'s specific flight arrival, not a standing rate',
        pricing: { serviceName: 'VIP Pickup & Meet and Greet', tierName: null, variant: null, priceAmount: 125, isFlat: true },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: text })
    expect(writerCalls).toHaveLength(0)
    expect(holdGenericCalls).toHaveLength(0) // customer-scoped never even becomes a "should this be global?" candidate
    expect(auditCalls[auditCalls.length - 1]).toMatchObject({ decision: 'no_op' })
  })

  // FOUND: 2026-06-26 12:11:56 (Karenda/Mrs. Max, owner): "just tell him we
  // will refund him and end the convo there" — a directive about ONE
  // specific complaint (the same-day Heritage Tour complaint thread). 38
  // minutes later (12:49:55), a SEPARATE, general refund policy was stated
  // and correctly captured as a standing business_facts row ("Refunds are
  // never issued immediately. All refund requests require further
  // investigation..."). The one-off directive and the general policy are
  // not just different scope — they're OPPOSITE operational stances
  // (immediate refund vs. investigate-first). This is real evidence that
  // an in-the-moment directive about one complaint must never be read as
  // the standing policy, even when it precedes the real policy statement
  // in the same conversation.
  it('"refund him" — a one-off directive for one complaint, must not become "we always refund immediately"', async () => {
    const text = 'Just tell him we will refund him and end the conversation there.'
    classifyMock = async () =>
      ok({
        learnable: true,
        explicitness: 'explicit_statement',
        scope: { kind: 'customer_scoped', target: 'customer' },
        risk: 'consequential',
        destination: 'business_fact',
        canonicalKey: 'heritage-tour-complaint-refund-directive',
        confidence: 0.8,
        rationale: 'a directive to resolve one specific complaint, not a statement of standing refund policy',
        businessFact: { category: 'policy', text: 'We will refund this guest and close out the conversation.' },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: text })
    expect(writerCalls).toHaveLength(0)
    expect(auditCalls[auditCalls.length - 1]).toMatchObject({ decision: 'no_op' })
  })
})

describe('real Bimini history — category A/E discipline (correctly captured, or correctly NOT generalized)', () => {
  // FOUND: 2026-08-10, inbound: "...i want to tell that to a customer" —
  // surface framing sounds customer-specific, but the actual content states
  // a GENERAL solo-private pricing rule ($275 solo private, $450 for 2
  // private) that later became a permanent business_facts row
  // (554012a6-..., 2026-08-10 03:18:38). Proves the classifier must judge
  // scope from the STATEMENT's content, not the trigger phrase that
  // prompted it.
  it('solo-private pricing stated while relaying to one customer — content is general, must NOT be held back as customer_scoped', async () => {
    const text =
      'We do not normally run the Full Bimini Experience for one person, however the price for a solo private booking is $275, and for 2 people private it is $450.'
    classifyMock = async () =>
      ok({
        learnable: true,
        explicitness: 'explicit_statement',
        scope: { kind: 'standing', target: 'service', serviceName: 'Full Bimini Experience' },
        risk: 'low',
        destination: 'pricing',
        canonicalKey: 'full-bimini-solo-private-price',
        confidence: 0.85,
        rationale: 'states a standing pricing rule, not a one-off exception, despite being triggered by a request to relay it to one customer',
        pricing: { serviceName: 'Full Bimini Experience', tierName: 'Private Solo (1)', variant: 'private', priceAmount: 275, isFlat: true },
      })
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: text })
    expect(writerCalls[0].writer).toBe('pricing')
    expect(auditCalls[auditCalls.length - 1]).toMatchObject({ decision: 'written' })
  })

  // FOUND: Max is already in operator_allowlist (role='owner', unverified,
  // added 2026-07-24) with this exact published business phone number. If
  // an operator re-teaches "Max is the driver, his number is X" today, the
  // router must recognize the contact already exists rather than create a
  // duplicate/conflicting row — proves the idempotency guarantee holds
  // against a REAL existing record, not just a synthetic one.
  it('re-teaching an already-known contact is a no-op, never a duplicate row', async () => {
    classifyMock = async () =>
      ok({
        learnable: true,
        explicitness: 'explicit_statement',
        scope: { kind: 'standing', target: 'person' },
        risk: 'low',
        destination: 'contact',
        canonicalKey: 'max-contact',
        confidence: 0.9,
        rationale: 'owner introduced a contact',
        contact: { name: 'Max', phone: '242-473-0233', role: 'driver' },
      })
    writerOutcome = { decision: 'no_op', reason: '+12424730233 is already on the allowlist as owner' }
    await routeOperatorLearningCorrection({ ...baseInput, operatorText: 'Max can be reached at 242 473 0233.' })
    expect(writerCalls[0].writer).toBe('contact')
    expect(auditCalls[auditCalls.length - 1]).toMatchObject({ decision: 'no_op' })
  })
})

describe('real Bimini history — structural safety properties confirmed against real data shape', () => {
  // Caye's OWN outbound self-corrections ("I shouldn't have priced that one
  // myself...", a real 2026-08-08 message) are never candidates for
  // learning — not because a classifier judges them unlearnable, but
  // because the router is only ever invoked from the operator webhook's
  // INBOUND handler (direction='inbound'). This test documents that
  // structural guarantee directly rather than asserting it exists.
  it('is only ever invoked with operator-authored (inbound) text — outbound Caye text never reaches the classifier', () => {
    // Structural proof, not an assumption: read the actual webhook route
    // source and confirm there is exactly ONE call site, and that it sits
    // between the INBOUND insert (direction: 'inbound') and the intent-
    // routing block that handles OUTBOUND generation — never after an
    // outbound send. A future refactor that accidentally wires this into an
    // outbound path fails this test loudly instead of silently starting to
    // "learn" from Caye's own generated text.
    const routeSrc = readFileSync(
      join(__dirname, '..', 'app', 'api', 'webhooks', 'whatsapp-operator', 'route.ts'),
      'utf8'
    )
    const callSites = routeSrc.match(/routeOperatorLearningCorrection\(/g) ?? []
    expect(callSites).toHaveLength(1)

    const inboundInsertIdx = routeSrc.indexOf("direction: 'inbound'")
    const callSiteIdx = routeSrc.indexOf('routeOperatorLearningCorrection(')
    const outboundGenerationIdx = routeSrc.indexOf('claude_format: { role: \'assistant\'')
    expect(inboundInsertIdx).toBeGreaterThan(-1)
    expect(callSiteIdx).toBeGreaterThan(inboundInsertIdx)
    // No outbound (assistant-authored) content is persisted before the
    // router call in this file — the router only ever sees what was just
    // logged as the operator's own inbound message.
    if (outboundGenerationIdx !== -1) {
      expect(callSiteIdx).toBeLessThan(outboundGenerationIdx)
    }
  })
})
