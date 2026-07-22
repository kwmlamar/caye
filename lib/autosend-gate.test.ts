import { describe, it, expect } from 'vitest'
import { applyAutosendGate } from './autosend-gate'
import type { CayeAutoReply } from './caye-reply'

describe('applyAutosendGate', () => {
  it('passes decisions through unchanged when autosend is enabled', () => {
    const decision: CayeAutoReply = { action: 'reply', content: 'Sure, happy to help!' }
    expect(applyAutosendGate(decision, true)).toEqual(decision)
  })

  it('converts a reply into a hold when autosend is disabled, preserving content as the draft', () => {
    const decision: CayeAutoReply = { action: 'reply', content: 'Sure, happy to help!' }
    const result = applyAutosendGate(decision, false)
    expect(result.action).toBe('hold')
    expect(result).toMatchObject({ action: 'hold', proposedReply: 'Sure, happy to help!' })
  })

  it('converts an escalate into a hold when autosend is disabled, preserving content as the draft', () => {
    const decision: CayeAutoReply = {
      action: 'escalate',
      content: "Let me check with the team and get back to you.",
      category: 'knowledge',
      routeTo: 'owner',
      internalContext: 'Prospect asked about integration with their existing booking tool.',
    }
    const result = applyAutosendGate(decision, false)
    expect(result.action).toBe('hold')
    expect(result).toMatchObject({
      action: 'hold',
      proposedReply: "Let me check with the team and get back to you.",
      note: 'Prospect asked about integration with their existing booking tool.',
    })
  })

  it('strips customerAcknowledgement from a hold when autosend is disabled', () => {
    const decision: CayeAutoReply = {
      action: 'hold',
      reason: 'Pricing question',
      note: 'Asked about pricing tiers.',
      proposedReply: 'Great question — let me get you the details.',
      customerAcknowledgement: "Thanks for reaching out, I'll follow up shortly.",
    }
    const result = applyAutosendGate(decision, false)
    expect(result.action).toBe('hold')
    expect((result as { customerAcknowledgement?: string }).customerAcknowledgement).toBeUndefined()
    expect((result as { proposedReply?: string }).proposedReply).toBe(
      'Great question — let me get you the details.'
    )
  })

  it('leaves a hold with no customerAcknowledgement untouched when autosend is disabled', () => {
    const decision: CayeAutoReply = {
      action: 'hold',
      reason: 'Ambiguous request',
      note: 'Not sure what they want.',
    }
    expect(applyAutosendGate(decision, false)).toEqual(decision)
  })
})
