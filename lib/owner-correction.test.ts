import { describe, it, expect } from 'vitest'
import { detectOwnerCorrection } from './owner-correction'

describe('detectOwnerCorrection', () => {
  it('tags as correction when the immediate prior message was a Caye auto-reply', () => {
    const result = detectOwnerCorrection({
      id: 'caye-msg-1',
      sender_type: 'business',
      metadata: { generated_by: 'caye', is_automated: true },
    })
    expect(result.is_correction).toBe(true)
    expect(result.corrected_caye_message_id).toBe('caye-msg-1')
  })

  it('does NOT tag when the prior message was a customer reply', () => {
    // Customer wrote → Caye replied → customer wrote BACK → owner replied.
    // Owner is responding to the customer, not correcting Caye.
    const result = detectOwnerCorrection({
      id: 'cust-msg-1',
      sender_type: 'customer',
      metadata: null,
    })
    expect(result.is_correction).toBe(false)
    expect(result.corrected_caye_message_id).toBeNull()
  })

  it('does NOT tag when the prior message was a previous owner reply', () => {
    // Owner already replied once, then sends another — that's a follow-up,
    // not a Caye correction.
    const result = detectOwnerCorrection({
      id: 'owner-msg-1',
      sender_type: 'business',
      metadata: { sent_by: 'human', source: 'zoho_sent' },
    })
    expect(result.is_correction).toBe(false)
    expect(result.corrected_caye_message_id).toBeNull()
  })

  it('does NOT tag when there is no prior message at all', () => {
    // Owner started the thread themselves (e.g. cold outreach via Zoho).
    const result = detectOwnerCorrection(null)
    expect(result.is_correction).toBe(false)
    expect(result.corrected_caye_message_id).toBeNull()
  })

  it('does NOT tag when prior business message lacks generated_by=caye', () => {
    // Defensive: a business message with weird metadata isn't proven to be
    // a Caye message, so don't treat the next owner reply as a correction.
    const result = detectOwnerCorrection({
      id: 'unknown-msg-1',
      sender_type: 'business',
      metadata: { source: 'manual_import' },
    })
    expect(result.is_correction).toBe(false)
    expect(result.corrected_caye_message_id).toBeNull()
  })

  it('handles missing metadata gracefully (legacy rows)', () => {
    const result = detectOwnerCorrection({
      id: 'legacy-msg-1',
      sender_type: 'business',
      metadata: null,
    })
    expect(result.is_correction).toBe(false)
  })
})
