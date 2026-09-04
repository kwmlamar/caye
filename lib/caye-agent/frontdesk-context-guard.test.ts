import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  detectRedundantCurrentChannelInstruction,
  detectUnsupportedFutureActionCommitment,
} from './frontdesk-context-guard'

describe('CAY-110 current-channel awareness', () => {
  it('blocks telling an email customer to reach out at the same active business address', () => {
    expect(
      detectRedundantCurrentChannelInstruction({
        body: 'Please feel free to reach out directly at info@tourbimini.com and we will get that sent over to you.',
        channelType: 'email',
        currentBusinessEmails: ['info@tourbimini.com'],
      })
    ).toMatch(/already/i)
  })

  it('blocks generic email-us instructions when the customer is already emailing', () => {
    expect(
      detectRedundantCurrentChannelInstruction({
        body: 'If you need anything else, email us and we can help.',
        channelType: 'email',
        currentBusinessEmails: ['info@tourbimini.com'],
      })
    ).toMatch(/already/i)
  })

  it('allows an intentional redirect to a genuinely different authorized email address', () => {
    expect(
      detectRedundantCurrentChannelInstruction({
        body: 'For media requests, contact photos@tourbimini.com directly.',
        channelType: 'email',
        currentBusinessEmails: ['info@tourbimini.com'],
      })
    ).toBeNull()
  })

  it('does not confuse a normal invitation to ask questions with a channel redirect', () => {
    expect(
      detectRedundantCurrentChannelInstruction({
        body: "Please don't hesitate to reach out if you have any questions.",
        channelType: 'email',
        currentBusinessEmails: ['info@tourbimini.com'],
      })
    ).toBeNull()
  })

  it('blocks telling a WhatsApp customer to message the business on WhatsApp', () => {
    expect(
      detectRedundantCurrentChannelInstruction({
        body: 'Message us on WhatsApp if you need anything.',
        channelType: 'whatsapp',
      })
    ).toMatch(/already/i)
  })
})

describe('CAY-110 future-action commitment grounding', () => {
  it('blocks the Laney-style unsupported promise to get a photo sent', () => {
    expect(
      detectUnsupportedFutureActionCommitment(
        'Max would be happy to share the photo with the team. We will get that sent over to you.',
        'Max enjoyed meeting the NBCUniversal crew.'
      )
    ).toMatch(/unsupported future send/i)
  })

  it('allows a scoped owner instruction that actually authorizes sending the photo', () => {
    expect(
      detectUnsupportedFutureActionCommitment(
        'We will get the photo sent over to you.',
        'Owner instruction: send Laney the photo Max took with the team.'
      )
    ).toBeNull()
  })

  it('blocks unsupported promises to follow up later', () => {
    expect(
      detectUnsupportedFutureActionCommitment(
        "We'll follow up tomorrow with the final details.",
        'Pickup is at the casino at 10am.'
      )
    ).toMatch(/unsupported future follow-up/i)
  })

  it('blocks the Charissa-style third-person promise that the owner will send an invoice', () => {
    expect(
      detectUnsupportedFutureActionCommitment(
        'Mrs. Max will be sending your invoice to ckhn@hotmail.com shortly.',
        'The invoice has not yet been sent. Booking total is $450.'
      )
    ).toMatch(/unsupported future send/i)
  })

  it('blocks the Jonathan-style promise to be in touch with details when no follow-up is grounded', () => {
    expect(
      detectUnsupportedFutureActionCommitment(
        'We will take care of the coordination and be in touch shortly with the details.',
        'Customer is interested in snorkeling and Snuba through a trusted partner.'
      )
    ).toMatch(/unsupported future follow-up/i)
  })

  it('allows a grounded be-in-touch commitment when a follow-up instruction exists', () => {
    expect(
      detectUnsupportedFutureActionCommitment(
        'We will be in touch tomorrow with the details.',
        'Owner instruction: follow up with Jonathan tomorrow after partner confirmation.'
      )
    ).toBeNull()
  })

  it('does not block non-promissory courtesy language', () => {
    expect(
      detectUnsupportedFutureActionCommitment(
        'We look forward to welcoming you tomorrow. Please reach out if you have any questions.',
        ''
      )
    ).toBeNull()
  })

  it('reads an inflected transfer verb as a promise, not just the bare stem', () => {
    expect(
      detectUnsupportedFutureActionCommitment(
        'We will be forwarding the signed contract to you this afternoon.',
        'Customer asked when the contract would arrive.'
      )
    ).toMatch(/unsupported future send/i)
  })

  it('refuses to treat a grounding that says a thing has NOT happened as authorisation', () => {
    expect(
      detectUnsupportedFutureActionCommitment(
        'We will send your invoice today.',
        'The invoice has not yet been sent.'
      )
    ).toMatch(/unsupported future send/i)
    expect(
      detectUnsupportedFutureActionCommitment(
        'We will send your invoice today.',
        'The invoice was not sent.'
      )
    ).toMatch(/unsupported future send/i)
  })

  it('still allows a grounding that says the send is authorised', () => {
    expect(
      detectUnsupportedFutureActionCommitment(
        'Mrs. Max will be sending your invoice shortly.',
        'Owner instruction: Max is sending Charissa the invoice for the $450 booking.'
      )
    ).toBeNull()
  })

  it('does not flag a reply that declines to commit', () => {
    expect(
      detectUnsupportedFutureActionCommitment(
        'We will not be sending an invoice for this one.',
        'Booking total is $450.'
      )
    ).toBeNull()
  })

  it('does not mistake experiential sharing for a promised file transfer', () => {
    expect(
      detectUnsupportedFutureActionCommitment(
        'We will share the history, culture, and beauty of Bimini with you during the tour.',
        ''
      )
    ).toBeNull()
  })
})
