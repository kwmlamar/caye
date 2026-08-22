import { describe, it, expect } from 'vitest'
import { enforceActionGrounding, type ExecutedToolOutcome } from './action-claim-guard'

describe('enforceActionGrounding — send claims', () => {
  it('strips a "sent" claim when no send tool executed at all (2026-08-16 Mrs. Max incident)', () => {
    const replyText =
      "Here's what I sent her on WhatsApp just now:\n\n---\n\nHi Mrs. Max — quick question about Kenneth Cal.\n\n---\n\nI've set a reminder for 2pm today in case she hasn't replied by then."
    const executed: ExecutedToolOutcome[] = [
      { name: 'get_customer', ok: true },
      { name: 'get_team_members', ok: true },
      { name: 'schedule_reminder', ok: true },
    ]
    const { text, violations } = enforceActionGrounding(replyText, executed)

    expect(violations).toHaveLength(1)
    expect(violations[0].category).toBe('send')
    expect(text).not.toContain("Here's what I sent her on WhatsApp just now")
    expect(text).toContain("I have not actually sent anything")
    // The grounded reminder claim survives untouched.
    expect(text).toContain("I've set a reminder for 2pm today")
  })

  it('lets a "sent" claim through when send_reply actually succeeded this turn', () => {
    const replyText = 'I sent her that reply just now.'
    const executed: ExecutedToolOutcome[] = [{ name: 'send_reply', ok: true }]
    const { text, violations } = enforceActionGrounding(replyText, executed)
    expect(violations).toHaveLength(0)
    expect(text).toBe(replyText)
  })

  it('strips a "sent" claim when the send tool was called but FAILED', () => {
    const replyText = 'I messaged him about the price change.'
    const executed: ExecutedToolOutcome[] = [{ name: 'send_reply', ok: false }]
    const { text, violations } = enforceActionGrounding(replyText, executed)
    expect(violations).toHaveLength(1)
    expect(text).not.toContain('I messaged him')
  })

  it('strips a "sent" claim when the send tool only staged a pending confirmation (awaiting approval)', () => {
    const replyText = 'I sent that reply to the customer.'
    const executed: ExecutedToolOutcome[] = [{ name: 'send_reply', ok: true, pendingOnly: true }]
    const { text, violations } = enforceActionGrounding(replyText, executed)
    expect(violations).toHaveLength(1)
    expect(text).not.toContain('I sent that reply')
  })

  it('does not flag a future-tense offer ("I\'ll send that") as a completion claim', () => {
    const replyText = "I'll send that over once you confirm the price."
    const { text, violations } = enforceActionGrounding(replyText, [])
    expect(violations).toHaveLength(0)
    expect(text).toBe(replyText)
  })

  it('strips a stale-claim rephrasing with an adverb between subject and verb (2026-08-16 regression: "I already sent... 3 hours ago")', () => {
    const replyText =
      "I already sent her that message 3 hours ago — it covers all four decisions (Kenneth's rate, Karin's payment method, Charissa's rate confirmation, Rayna's pricing). Still waiting on her reply."
    const { text, violations } = enforceActionGrounding(replyText, [])
    expect(violations).toHaveLength(1)
    expect(violations[0].category).toBe('send')
    expect(text).not.toContain('I already sent her')
    expect(text).toContain('I have not actually sent anything')
    // The rest of the message (not itself a completion claim) survives.
    expect(text).toContain('Still waiting on her reply')
  })

  it('also catches "earlier"/"previously" adverb variants', () => {
    expect(enforceActionGrounding('I earlier sent that to her.', []).violations).toHaveLength(1)
    expect(enforceActionGrounding("I've previously messaged him about this.", []).violations).toHaveLength(1)
  })

  it('grounds a confirmed high-risk send routed through confirm_pending_action', () => {
    const replyText = 'Sent — she should have it now.'
    const executed: ExecutedToolOutcome[] = [
      { name: 'confirm_pending_action', ok: true },
      { name: 'send_reply', ok: true, pendingOnly: false },
    ]
    const { violations } = enforceActionGrounding(replyText, executed)
    expect(violations).toHaveLength(0)
  })
})

describe('enforceActionGrounding — schedule claims', () => {
  it('strips a "set a reminder" claim when schedule_reminder never ran', () => {
    const replyText = "I've set a reminder for tomorrow at 9am."
    const { text, violations } = enforceActionGrounding(replyText, [])
    expect(violations).toHaveLength(1)
    expect(violations[0].category).toBe('schedule')
    expect(text).toContain('was not able to actually schedule')
  })

  it('strips a "set a reminder" claim when schedule_reminder ran but failed', () => {
    const replyText = "I've created a follow-up for 2pm."
    const executed: ExecutedToolOutcome[] = [{ name: 'schedule_reminder', ok: false }]
    const { violations } = enforceActionGrounding(replyText, executed)
    expect(violations).toHaveLength(1)
  })

  it('lets a "set a reminder" claim through when schedule_reminder succeeded', () => {
    const replyText = "I've set a reminder for 2pm today."
    const executed: ExecutedToolOutcome[] = [{ name: 'schedule_reminder', ok: true }]
    const { text, violations } = enforceActionGrounding(replyText, executed)
    expect(violations).toHaveLength(0)
    expect(text).toBe(replyText)
  })
})

describe('enforceActionGrounding — booking handoffs', () => {
  it('removes the Mrs. Max booking/email handoff even when no booking tool ran', () => {
    const replyText =
      "I can't route around that block — the system won't send pickup instructions without a booking on file, and Jeff has none. You create the booking for Jeff, or you email him directly from your inbox. Don't forget to create his booking when you get a chance."

    const { text, violations } = enforceActionGrounding(replyText, [])

    expect(violations).toHaveLength(3)
    expect(violations.every((violation) => violation.category === 'booking-handoff')).toBe(true)
    expect(text).toContain('I’ll reconcile or create the booking here first')
    expect(text).not.toMatch(/route around that block|you create the booking|email him directly|don'?t forget to create/i)
  })

  it('never permits a booking handoff just because a different action succeeded', () => {
    const { text, violations } = enforceActionGrounding(
      "Please create her booking, then I'll send the email.",
      [{ name: 'send_reply', ok: true }]
    )

    expect(violations).toHaveLength(1)
    expect(text).not.toContain('Please create her booking')
  })
})

describe('enforceActionGrounding — general behavior', () => {
  it('passes claim-free text through completely untouched', () => {
    const replyText = 'Rayna is one reply away from booking. Want me to draft a nudge?'
    const { text, violations } = enforceActionGrounding(replyText, [])
    expect(violations).toHaveLength(0)
    expect(text).toBe(replyText)
  })

  it('only replaces the ungrounded sentence once even if the false claim repeats', () => {
    const replyText = 'I sent it to her. I sent it to her again to be safe.'
    const { text, violations } = enforceActionGrounding(replyText, [])
    expect(violations).toHaveLength(2)
    expect(text.match(/I have not actually sent anything/g)?.length).toBe(1)
  })
})
