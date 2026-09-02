import { describe, expect, it } from 'vitest'
import {
  buildHumanCommunicationRealizationInstructions,
  deriveHumanCommunicationPolicy,
  realizeHumanCommunicationFixture,
  type HumanCommunicationContext,
} from './human-communication-realization'

const operatorContext = (
  overrides: Partial<HumanCommunicationContext> = {}
): HumanCommunicationContext => ({
  recipientRole: 'operator',
  channel: 'whatsapp',
  purpose: 'informational_update',
  responseRequired: false,
  approvalRequired: false,
  authorityHolder: 'operator',
  urgency: 'routine',
  materialUncertainty: false,
  issuePreviouslyMentioned: false,
  anythingChanged: true,
  priorConversationalContext: true,
  sharedContext: 'high',
  structuredOutputRequested: false,
  shortOperatorInput: false,
  ...overrides,
})

describe('human communication realization policy', () => {
  it('acknowledges Mrs. Max operator correction briefly instead of arguing with stored state', () => {
    const context = operatorContext({
      purpose: 'acknowledgement',
      shortOperatorInput: true,
      anythingChanged: true,
    })

    expect(deriveHumanCommunicationPolicy(context)).toMatchObject({
      mode: 'brief_acknowledgement',
      askForResponse: false,
      maxSentences: 2,
    })
    expect(
      realizeHumanCommunicationFixture({
        context,
        acknowledgement: "Got it. I'll leave that one alone.",
      })
    ).toBe("Got it. I'll leave that one alone.")
  })

  it('suppresses a repeated unchanged Jonathan issue when no response is needed', () => {
    const context = operatorContext({
      purpose: 'issue_update',
      issuePreviouslyMentioned: true,
      anythingChanged: false,
      responseRequired: false,
    })

    expect(deriveHumanCommunicationPolicy(context).mode).toBe('suppress')
    expect(
      realizeHumanCommunicationFixture({
        context,
        update:
          "HELD ITEM: Jonathan Garcia. AUTHORITY: OWNER. APPROVAL REQUIRED. He was already surfaced yesterday.",
        repeatedReference: "Jonathan's still waiting, no change.",
      })
    ).toBe('')
  })

  it('compresses a repeated unchanged issue when it still requires the owner', () => {
    const context = operatorContext({
      purpose: 'approval_request',
      issuePreviouslyMentioned: true,
      anythingChanged: false,
      responseRequired: true,
      approvalRequired: true,
      authorityHolder: 'owner',
    })

    expect(deriveHumanCommunicationPolicy(context).mode).toBe('compressed')
    expect(
      realizeHumanCommunicationFixture({
        context,
        repeatedReference: "Jonathan's still waiting on that call from you.",
        approvalRequest: 'Should I confirm the refund once you approve it?',
      })
    ).toBe(
      "Jonathan's still waiting on that call from you. Should I confirm the refund once you approve it?"
    )
  })

  it('does not manufacture a CTA for an informational update', () => {
    const context = operatorContext({ purpose: 'informational_update', responseRequired: false })
    const policy = deriveHumanCommunicationPolicy(context)
    const instructions = buildHumanCommunicationRealizationInstructions(context)

    expect(policy.askForResponse).toBe(false)
    expect(instructions).toContain('No response is required.')
    expect(
      realizeHumanCommunicationFixture({
        context,
        update: 'Both afternoon tours are confirmed.',
      })
    ).toBe('Both afternoon tours are confirmed.')
  })

  it('preserves a real approval gate and authority requirement', () => {
    const context = operatorContext({
      purpose: 'approval_request',
      responseRequired: true,
      approvalRequired: true,
      authorityHolder: 'owner',
    })

    const policy = deriveHumanCommunicationPolicy(context)
    expect(policy).toMatchObject({
      askForResponse: true,
      requireApprovalRequest: true,
    })
    expect(
      realizeHumanCommunicationFixture({
        context,
        update: 'Sonja wants the pickup moved from 9 to 10.',
        approvalRequest: 'Can I confirm 10 with her?',
      })
    ).toBe('Sonja wants the pickup moved from 9 to 10. Can I confirm 10 with her?')
  })

  it('keeps short operator turns short unless material uncertainty requires more', () => {
    const short = deriveHumanCommunicationPolicy(
      operatorContext({ purpose: 'acknowledgement', shortOperatorInput: true })
    )
    const uncertain = deriveHumanCommunicationPolicy(
      operatorContext({
        purpose: 'acknowledgement',
        shortOperatorInput: true,
        materialUncertainty: true,
      })
    )

    expect(short.maxSentences).toBe(2)
    expect(uncertain.mode).not.toBe('brief_acknowledgement')
    expect(uncertain.preserveUncertainty).toBe(true)
  })

  it('keeps held/authority/approval taxonomy internal while preserving the meaning', () => {
    const context = operatorContext({
      purpose: 'approval_request',
      responseRequired: true,
      approvalRequired: true,
      authorityHolder: 'owner',
    })
    const policy = deriveHumanCommunicationPolicy(context)
    const output = realizeHumanCommunicationFixture({
      context,
      update: "Jonathan's still waiting on that call from you.",
      approvalRequest: 'Should I send the confirmation after you decide?',
    })

    expect(policy.exposeInternalTaxonomy).toBe(false)
    expect(output).not.toMatch(/status=held|authority=owner|approval_required/i)
    expect(output).toContain("Jonathan's still waiting")
  })

  it('keeps structured output available when the operator explicitly asks for it', () => {
    const context = operatorContext({
      purpose: 'structured_report',
      structuredOutputRequested: true,
      sharedContext: 'low',
    })

    expect(deriveHumanCommunicationPolicy(context)).toMatchObject({
      mode: 'structured',
      maxSentences: null,
    })
    expect(buildHumanCommunicationRealizationInstructions(context)).toContain(
      'explicitly requested structured output'
    )
  })

  it('preserves material uncertainty in natural wording', () => {
    const context = operatorContext({
      purpose: 'informational_update',
      materialUncertainty: true,
    })

    expect(deriveHumanCommunicationPolicy(context).preserveUncertainty).toBe(true)
    expect(
      realizeHumanCommunicationFixture({
        context,
        update: 'The driver is penciled in for 10.',
        uncertainty: "I haven't confirmed the pickup time with him yet.",
      })
    ).toBe("The driver is penciled in for 10. I haven't confirmed the pickup time with him yet.")
  })
})
