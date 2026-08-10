import { describe, it, expect } from 'vitest'
import { findDemoReplyLeak, demoRetryInstruction } from './caye-demo-guard'

// Verbatim from the demo turn that surfaced this (2026-08-10): Caye punted
// a ready-to-book guest to the owner instead of taking the booking.
const REAL_BAD_REPLY = `Amazing, so excited for you all!! 🎉🐠

Here's what I need to lock this in with Marcus:

*Please send him these details on WhatsApp:*
• Your name
• Best contact number
• Any allergies or health considerations we should know about
• And he'll confirm the exact meeting time at George Town marina!

👉 *WhatsApp Marcus:* [your number here]

Just say "Caye sent me — 4 people, Saturday snorkel trip" and he'll take it from there, including payment details and any last questions!`

describe('findDemoReplyLeak', () => {
  it('catches the real reply that punted the guest to the owner', () => {
    // Placeholder wins the race here — it's checked first — but this reply
    // trips both detectors.
    expect(findDemoReplyLeak(REAL_BAD_REPLY)).toBe('placeholder')
  })

  it('catches the handoff even with the placeholder removed', () => {
    const noPlaceholder = REAL_BAD_REPLY.replace('[your number here]', '242-555-0100')
    expect(findDemoReplyLeak(noPlaceholder)).toBe('handoff')
  })

  it.each([
    '[your number here]',
    'Text him at [phone]',
    'Ask for [name] when you arrive',
    'Book here: [link]',
  ])('flags bracketed placeholder: %s', (reply) => {
    expect(findDemoReplyLeak(reply)).toBe('placeholder')
  })

  it.each([
    'Please WhatsApp Marcus directly to sort the rest out.',
    'Just reach out to him and he will confirm the time.',
    'Send her your contact number and she will take it from there.',
    'You can contact the owner about payment.',
    'Give them a call to finish the booking.',
  ])('flags handoff: %s', (reply) => {
    expect(findDemoReplyLeak(reply)).toBe('handoff')
  })

  it.each([
    "You're all booked for Saturday, 4 people — see you at George Town marina at 8:45am!\n→ In a live chat, this creates a real booking and notifies the owner.",
    "Perfect, I've got you down. We'll text you the meeting point the night before.",
    'Got it — I can take your details right here, no need to go anywhere else.',
    'Contact us anytime if your plans change.',
    "I'll pass this one to the owner and they'll follow up with you directly by tomorrow.\n→ In a live chat, this escalates to the owner.",
  ])('leaves a good reply alone: %s', (reply) => {
    expect(findDemoReplyLeak(reply)).toBeNull()
  })

  it('does not flag brackets with no letters', () => {
    expect(findDemoReplyLeak('The trip is $95pp [4] spots left')).toBeNull()
  })

  // The whole point of anchoring to an imperative: Caye saying she'll do
  // the contacting is correct behaviour, and uses the same words as the
  // failure mode.
  it.each([
    "No problem — I'll message him and confirm your time.",
    "I'll give them a call now and come straight back to you.",
    "We'll send her the manifest before Saturday.",
  ])('does not flag Caye doing the contacting herself: %s', (reply) => {
    expect(findDemoReplyLeak(reply)).toBeNull()
  })
})

describe('demoRetryInstruction', () => {
  it('names the placeholder problem specifically', () => {
    const text = demoRetryInstruction('placeholder')
    expect(text).toContain('bracketed placeholder')
    expect(text).toContain('RETRY')
  })

  it('names the handoff problem specifically', () => {
    const text = demoRetryInstruction('handoff')
    expect(text).toContain('contact the owner themselves')
    expect(text).toContain('complete the booking yourself')
  })
})
