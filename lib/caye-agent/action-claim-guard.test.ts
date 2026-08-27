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

describe('enforceActionGrounding — unsupported infrastructure claims (CAY-139, 2026-08-26 Bimini incident)', () => {
  it('strips a "the system is down" claim even when a draft tool actually ran and failed', () => {
    const replyText =
      "I tried a few times but the staging system is down right now — I kept your draft here for when it's back."
    const executed: ExecutedToolOutcome[] = [{ name: 'draft_in_inbox', ok: false }]
    const { text, violations } = enforceActionGrounding(replyText, executed)
    expect(violations).toHaveLength(1)
    expect(violations[0].category).toBe('unsupported-infrastructure-claim')
    expect(text).not.toMatch(/staging system is down/i)
  })

  it('strips a "backend issue" claim (test E)', () => {
    const replyText = "Looks like there's a backend issue with saving drafts right now."
    const { text, violations } = enforceActionGrounding(replyText, [])
    expect(violations).toHaveLength(1)
    expect(violations[0].category).toBe('unsupported-infrastructure-claim')
    expect(text).not.toMatch(/backend issue/i)
  })

  it('never grounds this claim on a successful tool call — nothing verifies platform health', () => {
    const replyText = 'The backend issue should be resolved now.'
    const executed: ExecutedToolOutcome[] = [{ name: 'draft_in_inbox', ok: true }]
    const { violations } = enforceActionGrounding(replyText, executed)
    expect(violations).toHaveLength(1)
  })

  it('leaves ordinary failure copy untouched', () => {
    const replyText = "I couldn't save it to the inbox. I kept the draft here."
    const { text, violations } = enforceActionGrounding(replyText, [])
    expect(violations).toHaveLength(0)
    expect(text).toBe(replyText)
  })

  it('leaves an unrelated business "down" sentence untouched (not "system/backend/server/platform")', () => {
    const replyText = 'Their WhatsApp number has been down since yesterday, according to Jeff.'
    const { text, violations } = enforceActionGrounding(replyText, [])
    expect(violations).toHaveLength(0)
    expect(text).toBe(replyText)
  })

  it('removes the false clause without injecting draft-specific prose into an unrelated (non-draft) turn (test G)', () => {
    // CAY-140 review finding: this backstop runs on every turn, with no
    // knowledge of whether the turn was about a draft at all. Injecting
    // "I couldn't save the draft to the inbox" here would itself be a false
    // claim on a turn that was never about a draft.
    const replyText = "The booking total is $450. Actually, the backend seems to be down for booking lookups too."
    const { text, violations } = enforceActionGrounding(replyText, [])
    expect(violations).toHaveLength(1)
    expect(text).not.toMatch(/backend seems to be down/i)
    expect(text).not.toMatch(/draft/i)
    // The true, unrelated sentence survives untouched.
    expect(text).toContain('The booking total is $450.')
  })
})

describe('enforceActionGrounding — unsupported platform-escalation claims (CAY-139/CAY-140, 2026-08-26)', () => {
  it('strips an implied/suggested escalation to TropiTech even when not phrased as already-done', () => {
    const replyText = 'This is probably worth flagging to the TropiTech team.'
    const { violations } = enforceActionGrounding(replyText, [])
    expect(violations).toHaveLength(1)
    expect(violations[0].category).toBe('unsupported-platform-escalation-claim')
  })

  it('strips a claim that TropiTech has already been notified (test D: unrelated send_reply does not ground it)', () => {
    const replyText = "I've already flagged this to TropiTech — they'll take a look."
    const executed: ExecutedToolOutcome[] = [{ name: 'send_reply', ok: true }]
    const { text, violations } = enforceActionGrounding(replyText, executed)
    expect(violations).toHaveLength(1)
    expect(violations[0].category).toBe('unsupported-platform-escalation-claim')
    expect(text).not.toMatch(/flagged this to TropiTech/i)
  })

  it('strips a claim that engineering was notified with no relevant execution (test C)', () => {
    const replyText = "I've notified engineering."
    const { text, violations } = enforceActionGrounding(replyText, [])
    expect(violations).toHaveLength(1)
    expect(violations[0].category).toBe('unsupported-platform-escalation-claim')
    expect(text).not.toMatch(/notified engineering/i)
  })

  it('CAY-140 regression: a TRUE completed send_operator_message notification to "the team" is NOT touched (test A)', () => {
    const replyText = "I've notified the team."
    const executed: ExecutedToolOutcome[] = [{ name: 'send_operator_message', ok: true }]
    const { text, violations } = enforceActionGrounding(replyText, executed)
    expect(violations).toHaveLength(0)
    expect(text).toBe(replyText)
  })

  it('CAY-140 regression: a TRUE completed escalate_to_owner notification to "the owner" is NOT touched (test B)', () => {
    const replyText = "I've notified the owner."
    const executed: ExecutedToolOutcome[] = [{ name: 'escalate_to_owner', ok: true }]
    const { text, violations } = enforceActionGrounding(replyText, executed)
    expect(violations).toHaveLength(0)
    expect(text).toBe(replyText)
  })

  it('CAY-140 regression: "the founder" is a reachable destination (send_operator_message targets owner/founder) — never in the blocked list', () => {
    const replyText = "I've let the founder know."
    const { text, violations } = enforceActionGrounding(replyText, [])
    expect(violations).toHaveLength(0)
    expect(text).toBe(replyText)
  })

  it('does not misfire on a future-tense offer to notify a person (test F)', () => {
    const replyText = 'I can notify Mrs. Max.'
    const { text, violations } = enforceActionGrounding(replyText, [])
    expect(violations).toHaveLength(0)
    expect(text).toBe(replyText)
  })

  it('removes the false clause without injecting draft-specific prose (test G)', () => {
    const replyText = 'The booking is confirmed for Saturday. I also flagged this pricing question to support.'
    const { text, violations } = enforceActionGrounding(replyText, [])
    expect(violations).toHaveLength(1)
    expect(text).not.toMatch(/flagged this pricing question to support/i)
    expect(text).not.toMatch(/draft/i)
    expect(text).toContain('The booking is confirmed for Saturday.')
  })

  // Multimodal Caye Direct follow-up (#87). retrieve_artifact_for_operator's
  // delivery is channel-decided, not model-decided — execute.ts only ever
  // pushes the delivery-qualified 'retrieve_artifact_for_operator:whatsapp'
  // entry when the tool result actually carried delivery: 'whatsapp'. This
  // suite tests enforceActionGrounding's OWN behavior against that entry
  // shape directly (execute.ts's construction of it is covered separately
  // in execute.test.ts).
  it('grounds a "sent" claim when retrieve_artifact_for_operator delivered over WhatsApp', () => {
    const replyText = "I've sent that pickup map over."
    const executed: ExecutedToolOutcome[] = [{ name: 'retrieve_artifact_for_operator:whatsapp', ok: true }]
    const { text, violations } = enforceActionGrounding(replyText, executed)
    expect(violations).toHaveLength(0)
    expect(text).toBe(replyText)
  })

  it('does NOT ground a "sent" claim from the bare (undelivered/inline) retrieve_artifact_for_operator entry alone', () => {
    const replyText = 'I sent you the photo of Max.'
    // What execute.ts actually pushes for an INLINE Caye Direct delivery:
    // the bare tool name only, never the ':whatsapp' qualified entry.
    const executed: ExecutedToolOutcome[] = [{ name: 'retrieve_artifact_for_operator', ok: true }]
    const { text, violations } = enforceActionGrounding(replyText, executed)
    expect(violations).toHaveLength(1)
    expect(violations[0].category).toBe('send')
    expect(text).not.toContain('I sent you the photo of Max')
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
