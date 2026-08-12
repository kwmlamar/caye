import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  normalizeDigest,
  renderDigestBody,
  digestClosingAsk,
  type InboundDigest,
} from './inbound-digest'
import { buildOperatorBrief, truncate } from './operator-brief'
import { detectInternalLeak } from './operator-text-guard'

/**
 * The real email, reconstructed to the shape that broke: ~300 characters of
 * greeting, thanks and compliments, and the actual request at the very end.
 * This ordering is not unusual — it is how business correspondence is
 * written — which is why prefix truncation was never salvageable.
 */
const PLEASANTRIES_THEN_ASK = [
  'Dear Karenda and Maxwell,',
  '',
  'Thank you for this very thoughtful and comprehensive list of questions. I appreciate',
  "the care you have taken to document everything clearly, both for our discussion and",
  'for your team’s reference. These are all excellent questions, and several touch on',
  'important operational details that I want to make sure I address thoroughly and',
  'accurately. Rather than provide partial answers now, I will circle back with a full',
  'written response early next week.',
  '',
  'In the meantime, could you confirm whether you can accommodate wheelchair users on',
  'the sunset cruise, and what your rate would be for groups of 12 or more? We are',
  'looking at roughly two departures a month from October.',
  '',
  'Best regards,',
  'Ruslan Prakapovich',
  'Accessible Travel Solutions',
].join('\n')

/** What the extractor should produce for the message above. */
const RUSLAN_DIGEST: InboundDigest = {
  sender: 'Ruslan Prakapovich',
  organization: 'Accessible Travel Solutions',
  intent:
    'wants recurring group bookings on the sunset cruise and needs wheelchair access confirmed plus a group rate',
  whyItMatters: 'Two departures a month from October would be steady repeat volume.',
  currentStatus: 'Full written answers to your questions are coming next week.',
  requestedAction: 'confirm wheelchair access and quote a rate for groups of 12+',
  deadline: 'Looking at October start',
  financialImpact: null,
  commitmentsMade: null,
  recommendedAction: 'Confirm access, quote the group rate, and get the October dates held.',
  decisionNeeded: 'What rate do you want on 12+ groups?',
  confidence: 'high',
  substantive: true,
  actionNeeded: true,
}

describe('inbound digest — the ask, not the opening paragraph', () => {
  it('carries the request that prefix truncation destroyed', () => {
    // Requirement 4. The old path quoted characters 0-400 of the message
    // above, which lands mid-sentence in the SECOND paragraph — before the
    // request has even been raised.
    const oldBehaviour = truncate(PLEASANTRIES_THEN_ASK, 400)
    expect(oldBehaviour).not.toMatch(/wheelchair/i)
    expect(oldBehaviour).not.toMatch(/groups of 12/i)
    expect(oldBehaviour).toMatch(/Thank you for this very thoughtful/)

    const rendered = renderDigestBody(RUSLAN_DIGEST).join('\n')
    expect(rendered).toMatch(/wheelchair/i)
    expect(rendered).toMatch(/group rate|groups of 12/i)
    expect(rendered).not.toMatch(/Thank you for this very thoughtful/)
    expect(rendered).not.toMatch(/Dear Karenda/)
  })

  it('never quotes the sender back at the owner', () => {
    const rendered = renderDigestBody(RUSLAN_DIGEST).join('\n')
    expect(rendered).not.toContain('wrote:')
    expect(rendered).not.toContain('"')
  })

  it('leads with who and what they want', () => {
    const [first] = renderDigestBody(RUSLAN_DIGEST)
    expect(first).toContain('Ruslan Prakapovich')
    expect(first).toContain('Accessible Travel Solutions')
    expect(first).toContain('recurring group bookings')
  })

  it('marks a recommendation as a position, not a fact', () => {
    const rendered = renderDigestBody(RUSLAN_DIGEST).join('\n')
    expect(rendered).toMatch(/My recommendation:/)
  })

  it('hedges the marker instead of hiding the opinion when confidence is low', () => {
    const rendered = renderDigestBody({ ...RUSLAN_DIGEST, confidence: 'low' }).join('\n')
    expect(rendered).toMatch(/Not certain on this one, but I'd lean toward/)
    expect(rendered).not.toMatch(/My recommendation:/)
  })

  it('states that nothing was promised, since that is what frees the owner', () => {
    const rendered = renderDigestBody(RUSLAN_DIGEST).join('\n')
    expect(rendered).toMatch(/Nothing promised on price or availability/)
  })

  it('surfaces a real commitment over the default', () => {
    const rendered = renderDigestBody({
      ...RUSLAN_DIGEST,
      commitmentsMade: 'a holding reply saying you would come back this week',
    }).join('\n')
    expect(rendered).toMatch(/Already promised: a holding reply/)
    expect(rendered).not.toMatch(/Nothing promised on price/)
  })
})

describe('inbound digest — a message with no ask yet', () => {
  /** The Ruslan email as it ACTUALLY arrived on 2026-08-12: a holding note. */
  const HOLDING_NOTE: InboundDigest = {
    sender: 'Ruslan Prakapovich',
    organization: 'Accessible Travel Solutions',
    intent:
      'acknowledging your questions and saying a full written answer is coming rather than a partial one',
    whyItMatters: null,
    currentStatus: 'Substance still to come.',
    requestedAction: null,
    deadline: null,
    financialImpact: null,
    commitmentsMade: null,
    recommendedAction: null,
    decisionNeeded: null,
    confidence: 'high',
    substantive: false,
    actionNeeded: false,
  }

  it('says so in two lines instead of manufacturing a brief', () => {
    const rendered = renderDigestBody(HOLDING_NOTE)
    expect(rendered).toHaveLength(2)
    expect(rendered.join('\n')).toMatch(/Nothing to decide yet/)
  })

  it('asks the owner for nothing', () => {
    // Requirement 9's sibling: no decision exists, so no question is invented.
    expect(digestClosingAsk(HOLDING_NOTE)).toBeNull()
  })

  it('produces a brief with no question mark at all', () => {
    const { brief } = buildOperatorBrief({
      trigger: 'b2b_partnership',
      contactName: 'Ruslan Prakapovich',
      body: PLEASANTRIES_THEN_ASK,
      digest: HOLDING_NOTE,
    })
    expect(brief).not.toContain('?')
    // And specifically not the locked closing ask, which asks two questions.
    expect(brief).not.toMatch(/Your call on whether to take this on/)
  })
})

describe('inbound digest — real content, nothing to do', () => {
  /**
   * The harbour-authority notice. Found by the live fixture run: the
   * extractor called it substantive, and it was RIGHT — reduced fuel-dock
   * hours genuinely affect operations. What it needed was a second flag, not
   * a correction. See InboundDigest.actionNeeded.
   */
  const NOTICE: InboundDigest = {
    sender: null,
    organization: 'Bimini Harbour Authority',
    intent: 'notifying operators that the Alice Town fuel dock is on reduced hours next week',
    whyItMatters: 'Worth knowing before you plan fuel stops that week.',
    currentStatus: null,
    requestedAction: null,
    deadline: 'Last week of September, normal hours resume October 1',
    financialImpact: null,
    commitmentsMade: null,
    recommendedAction: null,
    decisionNeeded: null,
    confidence: 'high',
    substantive: true,
    actionNeeded: false,
  }

  it('states it and stops — no ask', () => {
    const rendered = renderDigestBody(NOTICE).join('\n')
    expect(rendered).toMatch(/reduced hours/)
    expect(rendered).toMatch(/Nothing needed from you — noted\./)
    expect(digestClosingAsk(NOTICE)).toBeNull()
  })

  it('does NOT promise a follow-up that is never coming', () => {
    // The holding-note line would be a lie here: nothing more is arriving.
    const rendered = renderDigestBody(NOTICE).join('\n')
    expect(rendered).not.toMatch(/I'll bring it to you when the real answer lands/)
  })

  it('keeps a stated deadline visible even with nothing to do', () => {
    expect(renderDigestBody(NOTICE).join('\n')).toMatch(/Timing: Last week of September/)
  })

  it('produces a brief with no question mark, even under a forced trigger', () => {
    const { brief } = buildOperatorBrief({
      trigger: 'b2b_partnership',
      contactName: 'Bimini Harbour Authority',
      body: 'Notice to operators…',
      digest: NOTICE,
    })
    expect(brief).not.toContain('?')
  })

  it('normalizeDigest cannot mark a contentless message as needing action', () => {
    const d = normalizeDigest({ intent: 'thanks!', substantive: false, actionNeeded: true })
    expect(d?.actionNeeded).toBe(false)
  })
})

describe('inbound digest — brief assembly', () => {
  it('uses the extracted decision as the single closing question', () => {
    const { brief } = buildOperatorBrief({
      trigger: 'b2b_partnership',
      contactName: 'Ruslan Prakapovich',
      body: PLEASANTRIES_THEN_ASK,
      digest: RUSLAN_DIGEST,
    })
    expect(brief).toContain('What rate do you want on 12+ groups?')
    expect(brief.match(/\?/g)).toHaveLength(1)
  })

  it('falls back to the locked ask when the extractor phrased no decision', () => {
    const { brief } = buildOperatorBrief({
      trigger: 'refund',
      contactName: 'Marissa',
      body: 'I would like my deposit back please, we cannot make the date now.',
      digest: { ...RUSLAN_DIGEST, decisionNeeded: null },
    })
    expect(brief).toMatch(/Your call\. Tell me what to offer/)
  })

  it('drops the quote of Caye’s own holding line', () => {
    // Reporting your own good behaviour is not information. What was
    // PROMISED matters and survives via commitmentsMade; the verbatim
    // read-back of Caye's holding reply does not.
    const { brief } = buildOperatorBrief({
      trigger: 'b2b_partnership',
      contactName: 'Ruslan Prakapovich',
      body: PLEASANTRIES_THEN_ASK,
      alreadySent: "Thanks for reaching out. Let me get this in front of the team.",
      digest: RUSLAN_DIGEST,
    })
    expect(brief).not.toMatch(/So far Ruslan Prakapovich has only had a holding line from me/)
    expect(brief).not.toMatch(/Let me get this in front of the team/)
  })

  it('keeps the deterministic opening line', () => {
    const { brief } = buildOperatorBrief({
      trigger: 'b2b_partnership',
      contactName: 'Ruslan Prakapovich',
      body: PLEASANTRIES_THEN_ASK,
      digest: RUSLAN_DIGEST,
    })
    expect(brief.startsWith('B2B enquiry — needs your call.')).toBe(true)
  })

  it('still folds in calendar context', () => {
    const { brief } = buildOperatorBrief({
      trigger: 'custom_request',
      contactName: 'Ruslan Prakapovich',
      body: PLEASANTRIES_THEN_ASK,
      digest: RUSLAN_DIGEST,
      availability: { dateISO: '2026-10-04', bookingCount: 0 },
    })
    expect(brief).toMatch(/Calendar's clear on Sun 10\/4/)
  })

  it('falls back to the quote path when there is no digest', () => {
    // The degraded path still works — extraction failing must not mean no
    // ping at all.
    const { brief } = buildOperatorBrief({
      trigger: 'b2b_partnership',
      contactName: 'Ruslan Prakapovich',
      body: PLEASANTRIES_THEN_ASK,
    })
    expect(brief).toContain('Ruslan Prakapovich wrote:')
    expect(brief).toMatch(/Your call on whether to take this on/)
  })

  it('never lets machinery through, whichever path built it', () => {
    for (const digest of [RUSLAN_DIGEST, null]) {
      const { brief } = buildOperatorBrief({
        trigger: 'b2b_partnership',
        contactName: 'Ruslan Prakapovich',
        body: PLEASANTRIES_THEN_ASK,
        digest,
      })
      expect(detectInternalLeak(brief)).toBeNull()
    }
  })
})

describe('normalizeDigest', () => {
  it('requires an intent — without one there is no reading', () => {
    expect(normalizeDigest({ confidence: 'high', substantive: true })).toBeNull()
    expect(normalizeDigest({ intent: '   ' })).toBeNull()
  })

  it('treats the string "null" as absent, because models emit it', () => {
    const d = normalizeDigest({ intent: 'wants a quote', deadline: 'null', sender: 'None' })
    expect(d?.deadline).toBeNull()
    expect(d?.sender).toBeNull()
  })

  it('drops a field carrying internal machinery rather than rendering it', () => {
    const d = normalizeDigest({
      intent: 'wants a quote',
      currentStatus: 'Forced escalation — b2b_partnership (inbound classifier — B2B voice)',
    })
    expect(d?.currentStatus).toBeNull()
    expect(d?.intent).toBe('wants a quote')
  })

  it('defaults an unknown confidence to low rather than assuming high', () => {
    expect(normalizeDigest({ intent: 'x', confidence: 'certain' })?.confidence).toBe('low')
    expect(normalizeDigest({ intent: 'x' })?.confidence).toBe('low')
  })

  it('treats a missing substantive flag as substantive, so no ask gets buried', () => {
    expect(normalizeDigest({ intent: 'x' })?.substantive).toBe(true)
    expect(normalizeDigest({ intent: 'x', substantive: false })?.substantive).toBe(false)
  })
})
