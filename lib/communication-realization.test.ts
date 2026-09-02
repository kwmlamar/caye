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
  it('treats an operator resolution as a terse acknowledgement', () => {
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
    expect(instructions).toContain('Acknowledge it briefly and move on')
    expect(instructions).toContain('Keep reconciliation/checking internal')
  })

  it('suppresses an unchanged issue already surfaced', () => {
    const plan = planCommunication({ ...base, purpose: 'reminder', previouslyMentioned: true, changedSinceLastMention: false })
    expect(plan.resurfacing).toBe('suppress')
    expect(plan.cta).toBe('none')
  })

  it('does not repeat an unchanged approval ask on later turns', () => {
    const plan = planCommunication({
      ...base,
      purpose: 'approval_request',
      responseRequired: true,
      decisionRequired: true,
      previouslyMentioned: true,
      changedSinceLastMention: false,
      authorityRequirement: 'owner',
    })
    expect(plan.resurfacing).toBe('suppress')
    expect(plan.cta).toBe('none')
    expect(plan.preserveAuthorityRequirement).toBe(false)
  })

  it('resurfaces a previously mentioned issue only when something materially changes', () => {
    const plan = planCommunication({
      ...base,
      purpose: 'approval_request',
      responseRequired: true,
      decisionRequired: true,
      previouslyMentioned: true,
      changedSinceLastMention: false,
      urgencyIncreased: true,
      authorityRequirement: 'owner',
    })
    expect(plan.resurfacing).toBe('compressed')
    expect(plan.cta).toBe('decision')
    expect(plan.preserveAuthorityRequirement).toBe(true)
  })

  it('does not manufacture a CTA for an informational update', () => {
    const instructions = buildCommunicationRealizationInstructions(base)
    expect(planCommunication(base).cta).toBe('none')
    expect(instructions).toContain('End without a question, offer, permission check, or CTA')
  })

  it('preserves a first-time real approval requirement', () => {
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
    expect(instructions).toContain('Ask exactly one short, precise question')
    expect(instructions).toContain('required owner approval must remain explicit')
  })

  it('defaults normal conversation to terse while preserving safety detail', () => {
    expect(planCommunication(base).detail).toBe('terse')
    expect(planCommunication({ ...base, materialSafetyInformation: true }).detail).toBe('normal')
  })

  it('does not expose internal taxonomy', () => {
    const ctx: CommunicationContext = { ...base, purpose: 'approval_request', responseRequired: true, decisionRequired: true, authorityRequirement: 'owner' }
    const plan = planCommunication(ctx)
    const instructions = buildCommunicationRealizationInstructions(ctx)
    expect(plan.exposeInternalTaxonomy).toBe(false)
    expect(instructions).toContain('Do not mechanically expose internal field names')
  })

  it('keeps explicitly requested structured reporting available', () => {
    const ctx: CommunicationContext = { ...base, purpose: 'structured_report', explicitStructuredReport: true }
    const plan = planCommunication(ctx)
    const instructions = buildCommunicationRealizationInstructions(ctx)
    expect(plan.detail).toBe('structured')
    expect(instructions).toContain('explicitly requested structured reporting')
    expect(instructions).toContain('implementation-only taxonomy private')
  })

  it('preserves material uncertainty', () => {
    const ctx = { ...base, materialUncertainty: true }
    expect(planCommunication(ctx).preserveUncertainty).toBe(true)
    expect(buildCommunicationRealizationInstructions(ctx)).toContain('Preserve it explicitly')
  })
})

describe('production-pattern fixtures', () => {
  it('stops the Jonathan-style repeated CTA after it has already been surfaced', () => {
    const ctx: CommunicationContext = {
      ...base,
      purpose: 'approval_request',
      responseRequired: true,
      decisionRequired: true,
      previouslyMentioned: true,
      changedSinceLastMention: false,
      authorityRequirement: 'owner',
    }
    const plan = planCommunication(ctx)
    const instructions = buildCommunicationRealizationInstructions(ctx)
    expect(plan).toMatchObject({ resurfacing: 'suppress', cta: 'none' })
    expect(instructions).toContain('do not repeat its approval question')
  })

  it('keeps a changed urgent issue concise', () => {
    const plan = planCommunication({ ...base, purpose: 'reminder', previouslyMentioned: true, urgencyIncreased: true })
    expect(plan).toMatchObject({ resurfacing: 'compressed', detail: 'terse' })
  })
})
