import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { hasExplicitExternalDraftIntent } from './external-draft-intent'

describe('hasExplicitExternalDraftIntent — CAY-9 Pam regression', () => {
  it.each([
    'draft please',
    'Draft',
    'draft a short reply to Pam',
    'make it shorter',
    'change from 450',
    'they need to know how much persons are maximum and minimum',
  ])('does not inherit an external destination for ordinary compose/revision language: %s', (operatorText) => {
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

  it.each(['yes', 'yes please', 'yes as a draft', 'go ahead']) (
    'allows %s only when Caye immediately offered the external destination',
    (operatorText) => {
      expect(
        hasExplicitExternalDraftIntent({
          operatorText,
          previousCayeText: 'Ready — confirm and I’ll file it to your Drafts now.',
        })
      ).toBe(true)
    }
  )

  it('does not turn a generic yes into external-draft intent after an inline draft', () => {
    expect(
      hasExplicitExternalDraftIntent({
        operatorText: 'yes please',
        previousCayeText: 'Draft for Pam: Dear Pam... Send that?',
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
