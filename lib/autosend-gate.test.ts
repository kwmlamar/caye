import { describe, it, expect } from 'vitest'
import { applyAutosendGate } from './autosend-gate'
import { detectInternalLeak } from './operator-text-guard'
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

  it('surfaces the caller-supplied hold reason instead of the autosend default', () => {
    // The gate now backs three distinct causes (autosend off, workspace
    // paused, thread held for a human). The operator-facing reason has to say
    // which one actually fired — "Autosend disabled" on a human-held thread
    // sent us looking at the wrong switch on 2026-08-08.
    const decision: CayeAutoReply = { action: 'reply', content: 'Sure, happy to help!' }
    const result = applyAutosendGate(
      decision,
      false,
      'Thread is held for a human — Caye did not reply'
    )
    expect(result).toMatchObject({
      action: 'hold',
      reason: 'Thread is held for a human — Caye did not reply',
      proposedReply: 'Sure, happy to help!',
    })
  })

  it('keeps the caller-supplied reason when collapsing an escalate', () => {
    const decision: CayeAutoReply = {
      action: 'escalate',
      content: 'Let me check with the team.',
      category: 'knowledge',
      routeTo: 'owner',
      internalContext: 'Guest asked about a package the owner prices herself.',
    }
    const result = applyAutosendGate(decision, false, 'Thread is held for a human')
    expect((result as { reason?: string }).reason).toMatch(/held for a human/)
    expect((result as { reason?: string }).reason).toMatch(/what Caye knows about the business/)
  })

  it('translates the category into a human label instead of the raw enum (Ruslan Prakapovich, 2026-08-17)', () => {
    // The exact sentence that reached the operator: "Ruslan Prakapovich came
    // in — Thread is held for a human — Caye did not reply (would have
    // escalated: sensitive)." `sensitive` is the raw EscalationCategory enum
    // value — applyAutosendGate wrote it straight into the reason that later
    // gets composed into the WhatsApp ping.
    const decision: CayeAutoReply = {
      action: 'escalate',
      content: "Thanks for reaching out — let me get this in front of the team and we'll be back to you shortly.",
      category: 'sensitive',
      routeTo: 'owner',
      internalContext: 'B2B partnership inquiry from Ruslan Prakapovich.',
    }
    const result = applyAutosendGate(
      decision,
      false,
      'Thread is held for a human — Caye did not reply'
    )
    const reason = (result as { reason?: string }).reason ?? ''
    // The bare enum shape must be gone — a human phrase describing the
    // matter (which may itself legitimately use the word "sensitive") is
    // fine; the raw single-token enum in a machine-shaped parenthetical is
    // not.
    expect(reason).not.toMatch(/\(would have escalated:\s*[a-z_]+\)/i)
    expect(detectInternalLeak(reason)).toBeNull()
  })
})
