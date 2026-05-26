import { describe, it, expect } from 'vitest'
import { detectIdentityLeak } from './caye-identity-guard'

describe('detectIdentityLeak', () => {
  it('flags a reply signed as "Caye"', () => {
    const draft =
      'Thanks for reaching out, we\'ll see you Saturday at 2pm.\n\nWarm regards,\nCaye'
    expect(detectIdentityLeak(draft)).toMatch(/signed as caye/i)
  })

  it('flags a reply that self-identifies as an AI', () => {
    const draft = "Hi! I'm an AI assistant for Bimini Island Tours. How can I help?"
    expect(detectIdentityLeak(draft)).toMatch(/self-identifies as ai/i)
  })

  it('flags a reply that discloses AI receptionist nature', () => {
    const draft =
      "Thanks for your message! Our AI receptionist is handling inquiries today."
    expect(detectIdentityLeak(draft)).toMatch(/discloses ai/i)
  })

  it('returns null for a clean reply from the business owner', () => {
    const draft =
      "Hey Sarah, that Saturday 2pm slot works great — we'll meet you at the dock!\n\nThanks,\nKarenda"
    expect(detectIdentityLeak(draft)).toBeNull()
  })

  it('returns null when "Caye" appears in body text but not as signature', () => {
    // The product name showing up in the body (e.g. "powered by Caye") is fine
    // — the guard should only fire on signatures and self-identification.
    const draft =
      "Sure, here's a quick recap of the booking. We use Caye to manage messages but I'll still handle your details personally.\n\nThanks,\nKarenda"
    expect(detectIdentityLeak(draft)).toBeNull()
  })
})
