import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { hasExplicitExternalDraftIntent } from './external-draft-intent-gate'

describe('hasExplicitExternalDraftIntent — CAY-9 Pam regression', () => {
  it.each([
    'draft please',
    'Draft',
    'draft a short reply to Pam',
    'change from 450',
    'they need to know how much persons are maximum and minimum',
    'yes as a draft',
  ])('does not inherit an external destination from ordinary compose/revision language: %s', (operatorText) => {
    expect(
      hasExplicitExternalDraftIntent({
        operatorText,
        previousCayeText: 'Done — it is in your Gmail Drafts on Pam’s thread now.',
      })
    ).toBe(false)
  })

  it.each([
    'put this in my email drafts',
    'save it as a Gmail draft',
    'create an email draft for Pam',
    'file this in my Drafts folder',
  ])('allows a direct request for the external artifact: %s', (operatorText) => {
    expect(hasExplicitExternalDraftIntent({ operatorText })).toBe(true)
  })

  it('allows a short yes only when Caye immediately offered the external destination', () => {
    expect(
      hasExplicitExternalDraftIntent({
        operatorText: 'yes please',
        previousCayeText: 'Want me to put that in your email Drafts?',
      })
    ).toBe(true)
  })

  it('does not turn a generic yes into external-draft intent', () => {
    expect(
      hasExplicitExternalDraftIntent({
        operatorText: 'yes please',
        previousCayeText: 'The revised draft is ready here. Send that?',
      })
    ).toBe(false)
  })

  it('allows an attachment handoff that requires the operator mail client', () => {
    expect(
      hasExplicitExternalDraftIntent({
        operatorText: 'draft the email so I can attach the photos and send it myself',
      })
    ).toBe(true)
  })
})
