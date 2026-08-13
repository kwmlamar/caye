import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { detectInternalLeak, founderBriefingLeak, stripToolMarkers, mediaPlaceholder } from './operator-text-guard'
import { detectForcedEscalation } from './forced-escalation'
import { QUIET_SENTINEL } from './quiet-scan'

// The two strings that actually reached Mrs. Max's Caye Direct thread on
// 2026-08-07. Kept verbatim so these tests fail if either leak returns.
const LEAKED_TURN = "You're welcome! Anytime. [tool_use: get_held_queue]"

describe('stripToolMarkers', () => {
  it('removes a marker from a mixed text + tool_use turn', () => {
    expect(stripToolMarkers(LEAKED_TURN)).toBe("You're welcome! Anytime.")
  })

  it('returns empty for a turn that is nothing but markers', () => {
    expect(stripToolMarkers('[tool_use: get_customer_history]')).toBe('')
    expect(stripToolMarkers('[tool_result] [tool_result]')).toBe('')
  })

  it('leaves ordinary prose untouched', () => {
    const clean = 'Two things worth flagging from the scan: Ruslan followed up again.'
    expect(stripToolMarkers(clean)).toBe(clean)
  })
})

describe('detectInternalLeak', () => {
  it('flags a raw tool marker', () => {
    expect(detectInternalLeak(LEAKED_TURN)).toMatch(/tool marker/)
  })

  it('flags the historical forced-escalation stem if it ever reappears', () => {
    // Hand-written fixture (not derived from the live producer) — this is
    // the literal machine-templated string that leaked into Mrs. Max's
    // Caye Direct thread on 2026-08-07. forced-escalation.ts was rewritten
    // 2026-08-14 to stop producing this shape (see the Inbox-redesign
    // pass), so the guard can no longer be exercised through the real
    // producer — but the pattern itself must keep catching this exact
    // shape if it's ever reintroduced anywhere else.
    const historicalLeak =
      'Forced escalation — b2b_partnership (inbound classifier — B2B / partnership voice). ' +
      'Customer message excerpt: "hi". Caye did not draft a substantive reply; the customer-facing ' +
      'send was a controlled template. Owner: review the thread and respond directly.'
    expect(detectInternalLeak(historicalLeak)).not.toBeNull()
  })

  it('the real forced-escalation producer no longer leaks (2026-08-14 fix)', () => {
    // Built through the real producer, now asserting the opposite of the
    // pre-fix test above: internalContext is plain founder-readable prose
    // (see TRIGGER_REASON / humanEscalationNote in forced-escalation.ts),
    // so it should never trip this guard in the first place.
    const forced = detectForcedEscalation('Partnership enquiry.', 'b2b_partnership')
    expect(forced).not.toBeNull()
    expect(detectInternalLeak(forced!.internalContext)).toBeNull()
  })

  it('passes clean operator prose, including prose that mentions escalating', () => {
    expect(detectInternalLeak('')).toBeNull()
    expect(
      detectInternalLeak(
        "B2B enquiry — needs your call. I escalated this to you rather than answering it myself."
      )
    ).toBeNull()
    expect(
      detectInternalLeak('Ruslan Prakapovich wrote: "Dear Karenda, Maxwell and Team…"')
    ).toBeNull()
  })

  // Requirements 1, 2 and 10. The literal string "[operator_reminder]" was in
  // Mrs. Max's Caye Direct thread on 2026-08-12 — operatorPingLogBody's
  // `default:` branch returned `[${kind}]` for every kind it had no case for.
  // The composer is fixed; this is the net under it, because the composer
  // being fixed is not the same as the class being closed.
  describe('bracketed internal event tokens', () => {
    it('flags the exact tokens that leaked', () => {
      expect(detectInternalLeak('[operator_reminder]')).toMatch(/internal event token/)
      expect(detectInternalLeak('[dropped_confirmation]')).toMatch(/internal event token/)
    })

    it('flags a token embedded in otherwise clean prose', () => {
      expect(
        detectInternalLeak("Morning, Mrs. Max — calendar's empty today.\n\n[operator_reminder]")
      ).toMatch(/internal event token/)
    })

    it('flags every kind the outbound worker can enqueue', () => {
      // Enumerated rather than sampled: the point of the pattern is that a
      // kind added tomorrow is covered without anyone remembering to add it.
      for (const kind of [
        'urgent_hold',
        'escalation',
        'escalation_followup',
        'booking_created',
        'morning_digest',
        'auth_failure',
        'opportunity_scan',
        'business_insights',
        'operator_reminder',
        'dropped_confirmation',
      ]) {
        // Single-word kinds have no underscore and are intentionally not
        // matched — see the "ordinary bracketed prose" case below.
        if (!kind.includes('_')) continue
        expect(detectInternalLeak(`[${kind}]`), kind).toMatch(/internal event token/)
      }
    })

    it('flags the [empty] turn marker', () => {
      expect(detectInternalLeak('[empty]')).toMatch(/internal event token/)
    })

    it('leaves ordinary bracketed prose alone', () => {
      // The pattern requires snake_case precisely so a human aside survives.
      expect(detectInternalLeak('Quoted her the group rate [see attached] and held it.')).toBeNull()
      expect(detectInternalLeak('Left it as a [draft] until you say go.')).toBeNull()
      expect(detectInternalLeak('Tour is $180 [per person] on the sunset run.')).toBeNull()
    })
  })

  it('flags the quiet-scan protocol sentinel', () => {
    // lib/quiet-scan.ts scrubs this belt-and-braces; this is the third layer,
    // so a new consumer of scan text that forgets fails a test rather than
    // shipping "NOTHING_TO_REPORT" to a phone. It leaked once, 2026-08-08.
    expect(detectInternalLeak('NOTHING_TO_REPORT — quiet round.')).toMatch(/quiet-scan sentinel/)
    expect(detectInternalLeak(QUIET_SENTINEL)).toMatch(/quiet-scan sentinel/)
  })
})

// The exact jargon that reached FounderHome's "Needs You" card live
// (2026-08-11/12) — the escalate_to_team tool path passes internal_context
// straight through from whatever the model generated, so a model narrating
// its own tool calls reaches the dashboard verbatim unless something catches
// it. Kept as hand-written fixtures, same reasoning as the forced-escalation
// ones above.
describe('founderBriefingLeak', () => {
  it('flags a bare snake_case tool/reason token in otherwise plain prose', () => {
    expect(founderBriefingLeak('lookup_price returned group_size_below_minimum for the golf cart tour.')).not.toBeNull()
    expect(founderBriefingLeak("check_availability shows the slot is open, but I wasn't sure.")).not.toBeNull()
  })

  it('flags self-rated confidence language', () => {
    expect(
      founderBriefingLeak('Caye self-rated confidence=medium on her reply, so it needs a check.')
    ).toMatch(/confidence-model language/)
  })

  it('flags an internal spec/layer reference', () => {
    expect(founderBriefingLeak('Per the Layer 2 spec, drafts ship even at medium confidence.')).toMatch(/spec reference/)
  })

  it('still catches everything detectInternalLeak catches', () => {
    expect(founderBriefingLeak('[operator_reminder]')).not.toBeNull()
  })

  it('passes clean, plain-English escalation notes', () => {
    expect(
      founderBriefingLeak(
        "Emily wants to book the Guided Golf Cart Tour for 3 people, but that's below the normal group " +
        "minimum. Can I offer her a private rate, or would you rather she join a bigger group?"
      )
    ).toBeNull()
    expect(
      founderBriefingLeak("I answered her, but I wasn't fully sure of what I said. Worth a read in case it needs correcting.")
    ).toBeNull()
  })
})

/**
 * Found in the 2026-08-12b audit. Four sites interpolated the raw WhatsApp
 * API enum into owner-facing text: two into caye_operator_messages.body
 * (Caye Direct), one into unified_conversations.last_message_preview — which
 * get_held_queue returns as `preview` for Caye to read out loud — and one
 * into unified_messages.content.
 */
describe('mediaPlaceholder — no raw message-type enums reach a human', () => {
  it('renders each known type as something a person would say', () => {
    expect(mediaPlaceholder('image')).toBe('Photo')
    expect(mediaPlaceholder('video')).toBe('Video')
    expect(mediaPlaceholder('audio')).toBe('Voice note')
    expect(mediaPlaceholder('ptt')).toBe('Voice note')
    expect(mediaPlaceholder('document')).toBe('Document')
    expect(mediaPlaceholder('sticker')).toBe('Sticker')
    expect(mediaPlaceholder('location')).toBe('Location')
    expect(mediaPlaceholder('contacts')).toBe('Contact card')
  })

  it('never echoes an unmapped type', () => {
    // Same rule as operatorPingLogBody's default: an unmapped value is a gap
    // in the renderer, not something to show a customer.
    expect(mediaPlaceholder('reaction')).toBe('Attachment')
    expect(mediaPlaceholder('some_future_type')).toBe('Attachment')
    expect(mediaPlaceholder(null)).toBe('Attachment')
    expect(mediaPlaceholder(undefined)).toBe('Attachment')
  })

  it('never returns brackets or an underscore token', () => {
    for (const t of ['image', 'audio', 'sticker', 'reaction', 'some_future_type', '', null]) {
      const out = mediaPlaceholder(t)
      expect(out, String(t)).not.toMatch(/[[\]]/)
      expect(detectInternalLeak(out), String(t)).toBeNull()
    }
  })
})
