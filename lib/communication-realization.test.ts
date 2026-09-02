import { describe, expect, it } from 'vitest'
import {
  buildCommunicationRealizationInstructions,
  planCommunication,
  type CommunicationContext,
} from './communication-realization'

const base: CommunicationContext = {
  purpose: 'informational_update',
  recipientRole: 'owner',
  channel: 'whatsapp',
  responseRequired: false,
  decisionRequired: false,
}

describe('communication realization policy', () => {
  it('treats "i dealt with it" as a short authoritative acknowledgement, not a database audit', () => {
    const ctx: CommunicationContext = {
      ...base,
      purpose: 'acknowledgement',
      priorTurn: 'i dealt with it',
      authoritativeOperatorCorrection: true,
    }
    const plan = planCommunication(ctx)
    const instructions = buildCommunicationRealizationInstructions(ctx)

    expect(plan.detail).toBe('terse')
    expect(plan.acknowledgeAuthorityFirst).toBe(true)
    expect(plan.cta).toBe('none')
    expect(instructions).toContain('Acknowledge that naturally first')
    expect(instructions).toContain('Keep reconciliation/checking internal')
  })

  it('suppresses an unchanged issue already surfaced yesterday instead of rebuilding a mini-report', () => {
    const plan = planCommunication({
      ...base,
      purpose: 'reminder',
      previouslyMentioned: true,
      changedSinceLastMention: false,
    })
    expect(plan.resurfacing).toBe('suppress')
  })

  it('compresses an unchanged issue when a real decision still requires resurfacing', () => {
    const plan = planCommunication({
      ...base,
      purpose: 'approval_request',
      responseRequired: true,
      decisionRequired: true,
      previouslyMentioned: true,
      changedSinceLastMention: false,
      authorityRequirement: 'owner',
    })
    expect(plan.resurfacing).toBe('compressed')
    expect(plan.cta).toBe('decision')
    expect(plan.preserveAuthorityRequirement).toBe(true)
  })

  it('does not manufacture a CTA for an informational update', () => {
    const instructions = buildCommunicationRealizationInstructions(base)
    expect(planCommunication(base).cta).toBe('none')
    expect(instructions).toContain('End the update without inventing a question')
  })

  it('preserves a real approval requirement and asks naturally', () => {
    const ctx: CommunicationContext = {
      ...base,
      purpose: 'approval_request',
      responseRequired: true,
      decisionRequired: true,
      authorityRequirement: 'owner',
    }
    const plan = planCommunication(ctx)
    const instructions = buildCommunicationRealizationInstructions(ctx)
    expect(plan.cta).toBe('decision')
    expect(plan.preserveAuthorityRequirement).toBe(true)
    expect(instructions).toContain('Ask one natural, precise question')
    expect(instructions).toContain('required owner approval must remain explicit')
  })

  it('matches short operator bandwidth unless safety information requires detail', () => {
    const terse = planCommunication({ ...base, priorTurn: 'done' })
    const safety = planCommunication({ ...base, priorTurn: 'done', materialSafetyInformation: true })
    expect(terse.detail).toBe('terse')
    expect(safety.detail).toBe('normal')
  })

  it('does not expose internal taxonomy by default', () => {
    const ctx: CommunicationContext = {
      ...base,
      purpose: 'approval_request',
      responseRequired: true,
      decisionRequired: true,
      authorityRequirement: 'owner',
    }
    const plan = planCommunication(ctx)
    const instructions = buildCommunicationRealizationInstructions(ctx)
    expect(plan.exposeInternalTaxonomy).toBe(false)
    expect(instructions).toContain('Do not mechanically expose internal field names')
    const internalState = { status: 'held', authority: 'owner', approval_required: true }
    expect(internalState).toEqual({ status: 'held', authority: 'owner', approval_required: true })
  })

  it('keeps structured reporting available without exposing implementation taxonomy', () => {
    const ctx: CommunicationContext = {
      ...base,
      purpose: 'structured_report',
      explicitStructuredReport: true,
    }
    const plan = planCommunication(ctx)
    const instructions = buildCommunicationRealizationInstructions(ctx)
    expect(plan.detail).toBe('structured')
    expect(plan.exposeInternalTaxonomy).toBe(false)
    expect(instructions).toContain('explicitly requested structured reporting')
    expect(instructions).toContain('implementation-only taxonomy private')
  })

  it('preserves material uncertainty in the realization contract', () => {
    const ctx = { ...base, materialUncertainty: true }
    const plan = planCommunication(ctx)
    const instructions = buildCommunicationRealizationInstructions(ctx)
    expect(plan.preserveUncertainty).toBe(true)
    expect(instructions).toContain('Preserve it explicitly')
    expect(instructions).toContain('do not smooth it into certainty')
  })
})

describe('Mrs. Max production-pattern fixtures', () => {
  it.each([
    {
      name: 'daily held-thread nag',
      before: '1 threads holding for you, 1 booked today. Oldest waiting: Jonathan Garcia - 13d. Want me to work through the held ones with you?',
      context: { ...base, purpose: 'informational_update' as const, previouslyMentioned: true, changedSinceLastMention: false },
      expected: { resurfacing: 'suppress', cta: 'none' },
    },
    {
      name: 'unchanged issue with changed urgency',
      before: "Backing off the daily nagging on Jonathan Garcia - still held, still needs your call, I just won't keep bringing it up every day.",
      context: { ...base, purpose: 'reminder' as const, previouslyMentioned: true, changedSinceLastMention: false, urgencyIncreased: true },
      expected: { resurfacing: 'compressed', cta: 'none' },
    },
    {
      name: 'operator correction',
      before: "I haven't seen your outbound reply land on Autumn McNeill's thread yet, so I left it open. Once it syncs, I can close it.",
      context: { ...base, purpose: 'acknowledgement' as const, priorTurn: 'i dealt with it', authoritativeOperatorCorrection: true },
      expected: { detail: 'terse', cta: 'none', acknowledgeAuthorityFirst: true },
    },
    {
      name: 'approval report leakage',
      before: 'Decision: Outreach is paused. Why it matters: cold first-touch emails are not going out. Recommendation: unpause. Proceed? Yes or No.',
      context: { ...base, purpose: 'approval_request' as const, responseRequired: true, decisionRequired: true, authorityRequirement: 'owner' as const },
      expected: { cta: 'decision', exposeInternalTaxonomy: false, preserveAuthorityRequirement: true },
    },
  ])('$name maps the failure pattern to deterministic policy', ({ context, expected }) => {
    expect(planCommunication(context)).toMatchObject(expected)
  })
})
