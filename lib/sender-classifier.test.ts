import { describe, it, expect } from 'vitest'
import { isNoReplySender, isCalendarInvite, isOutOfOffice } from './sender-classifier'

describe('isNoReplySender', () => {
  it('flags classic noreply local-parts', () => {
    expect(isNoReplySender('noreply@example.com')).toBe(true)
    expect(isNoReplySender('no-reply@example.com')).toBe(true)
    expect(isNoReplySender('donotreply@example.com')).toBe(true)
    expect(isNoReplySender('mailer-daemon@example.com')).toBe(true)
    expect(isNoReplySender('notifications@example.com')).toBe(true)
  })

  it('does NOT flag real human senders that look noreply-adjacent', () => {
    expect(isNoReplySender('karenda@tourbimini.com')).toBe(false)
    expect(isNoReplySender('valeriia@accessibletravelsolutions.com')).toBe(false)
    expect(isNoReplySender('jdstallings@protonmail.com')).toBe(false)
    // info@ is intentionally NOT in this gate — role addresses still get archived
    // via the auto-reply gate, not the auto-archive gate. See module comment.
    expect(isNoReplySender('info@tourbimini.com')).toBe(false)
  })

  it('handles null and empty inputs without throwing', () => {
    expect(isNoReplySender(null)).toBe(false)
    expect(isNoReplySender(undefined)).toBe(false)
    expect(isNoReplySender('')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isNoReplySender('NoReply@Example.COM')).toBe(true)
    expect(isNoReplySender('NOTIFICATIONS@x.io')).toBe(true)
  })
})

describe('isCalendarInvite', () => {
  it('flags Google Calendar invitation subject patterns', () => {
    expect(isCalendarInvite('Invitation: Bimini - ATS meeting @ Thu May 21', '')).toBe(true)
    expect(isCalendarInvite('Updated invitation: Bimini - ATS meeting', '')).toBe(true)
    expect(isCalendarInvite('Cancelled event: Bimini - ATS meeting', '')).toBe(true)
    expect(isCalendarInvite('Cancelled: Bimini - ATS meeting', '')).toBe(true)
  })

  it('flags response notifications', () => {
    expect(isCalendarInvite('Accepted: Bimini - ATS meeting', '')).toBe(true)
    expect(isCalendarInvite('Declined: Bimini - ATS meeting', '')).toBe(true)
    expect(isCalendarInvite('Tentative: Bimini - ATS meeting', '')).toBe(true)
  })

  it('flags VCALENDAR body content even without subject match', () => {
    const body = 'See attached invite.\nBEGIN:VCALENDAR\nVERSION:2.0\n...'
    expect(isCalendarInvite('Meeting tomorrow', body)).toBe(true)
  })

  it('handles forwarded / reply prefixes on calendar subjects', () => {
    expect(isCalendarInvite('Re: Invitation: Bimini - ATS meeting', '')).toBe(true)
    expect(isCalendarInvite('Fwd: Updated invitation: Bimini', '')).toBe(true)
  })

  it('does NOT flag normal customer inquiries that mention "invitation"', () => {
    expect(isCalendarInvite('Tour Booking: Jeff Montenaro', 'I would like an invitation to your tour')).toBe(false)
    expect(isCalendarInvite('Would love to come!', 'Thanks for the warm invitation to visit Bimini')).toBe(false)
  })

  it('handles null and empty inputs', () => {
    expect(isCalendarInvite(null, null)).toBe(false)
    expect(isCalendarInvite('', '')).toBe(false)
    expect(isCalendarInvite(null, '')).toBe(false)
  })

  it('is case-insensitive on subject', () => {
    expect(isCalendarInvite('INVITATION: Bimini meeting', '')).toBe(true)
    expect(isCalendarInvite('invitation: Bimini meeting', '')).toBe(true)
  })
})

describe('isOutOfOffice', () => {
  it('flags common OOO subject prefixes', () => {
    expect(isOutOfOffice('Automatic reply: Hello from TropiTech', '')).toBe(true)
    expect(isOutOfOffice('Auto-Reply: Hello from TropiTech', '')).toBe(true)
    expect(isOutOfOffice('Out of Office: Hello from TropiTech', '')).toBe(true)
    expect(isOutOfOffice('Out of Office', '')).toBe(true)
    expect(isOutOfOffice('Autoresponder: Hello from TropiTech', '')).toBe(true)
    expect(isOutOfOffice('Away from my desk', '')).toBe(true)
  })

  it('handles forwarded / reply prefixes on OOO subjects', () => {
    expect(isOutOfOffice('Re: Automatic reply: Hello from TropiTech', '')).toBe(true)
  })

  it('flags common OOO body phrasing even without a matching subject', () => {
    expect(
      isOutOfOffice('Hello from TropiTech', "I'm currently out of the office and will respond when I return.")
    ).toBe(true)
    expect(
      isOutOfOffice('Hello from TropiTech', 'I am away from my desk until Monday.')
    ).toBe(true)
    expect(
      isOutOfOffice(
        'Hello from TropiTech',
        "I am on vacation with limited access to email until next week."
      )
    ).toBe(true)
  })

  it('does NOT flag normal replies that happen to mention being busy', () => {
    expect(
      isOutOfOffice('Re: Hello from TropiTech', "Sorry for the slow reply, it's been a busy week here!")
    ).toBe(false)
    expect(isOutOfOffice('Interested — tell me more', 'What does Caye cost per month?')).toBe(false)
  })

  it('handles null and empty inputs', () => {
    expect(isOutOfOffice(null, null)).toBe(false)
    expect(isOutOfOffice('', '')).toBe(false)
    expect(isOutOfOffice(null, '')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isOutOfOffice('OUT OF OFFICE: reply', '')).toBe(true)
    expect(isOutOfOffice('out of office: reply', '')).toBe(true)
  })
})
