import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  detectInternalLeak,
  founderBriefingLeak,
  detectToolNameLeak,
  detectMailboxDraftRedirect,
  stripToolMarkers,
  mediaPlaceholder,
} from './operator-text-guard'
import { detectForcedEscalation } from './forced-escalation'
import { QUIET_SENTINEL } from './quiet-scan'

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
    const historicalLeak =
      'Forced escalation — b2b_partnership (inbound classifier — B2B / partnership voice). ' +
      'Customer message excerpt: "hi". Caye did not draft a substantive reply; the customer-facing ' +
      'send was a controlled template. Owner: review the thread and respond directly.'
    expect(detectInternalLeak(historicalLeak)).not.toBeNull()
  })

  it('the real forced-escalation producer no longer leaks', () => {
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

    it('flags every multiword kind the outbound worker can enqueue', () => {
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
        if (!kind.includes('_')) continue
        expect(detectInternalLeak(`[${kind}]`), kind).toMatch(/internal event token/)
      }
    })

    it('flags the [empty] turn marker', () => {
      expect(detectInternalLeak('[empty]')).toMatch(/internal event token/)
    })

    it('leaves ordinary bracketed prose alone', () => {
      expect(detectInternalLeak('Quoted her the group rate [see attached] and held it.')).toBeNull()
      expect(detectInternalLeak('Left it as a [draft] until you say go.')).toBeNull()
      expect(detectInternalLeak('Tour is $180 [per person] on the sunset run.')).toBeNull()
    })
  })

  it('flags the quiet-scan protocol sentinel', () => {
    expect(detectInternalLeak('NOTHING_TO_REPORT — quiet round.')).toMatch(/quiet-scan sentinel/)
    expect(detectInternalLeak(QUIET_SENTINEL)).toMatch(/quiet-scan sentinel/)
  })
})

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

const TOOL_NAMES = ['send_reply', 'confirm_pending_action', 'mark_handled']

describe('detectMailboxDraftRedirect — CAY-11 inline-only owner drafting', () => {
  it('flags instructions that send an owner to Gmail/Zoho/email Drafts', () => {
    expect(detectMailboxDraftRedirect("Open Gmail and check your Drafts folder for Pam's reply.")).not.toBeNull()
    expect(detectMailboxDraftRedirect('Go into Zoho Mail Drafts and review it there.')).not.toBeNull()
    expect(detectMailboxDraftRedirect('Check your email Drafts folder.')).not.toBeNull()
  })

  it('flags offers to file an owner draft externally', () => {
    expect(detectMailboxDraftRedirect('Want me to put it in your email drafts?')).not.toBeNull()
    expect(detectMailboxDraftRedirect('I can save this in Zoho Mail Drafts for you.')).not.toBeNull()
  })

  it('does not flag ordinary provider facts or inline drafting', () => {
    expect(detectMailboxDraftRedirect('Your business email is connected through Zoho Mail.')).toBeNull()
    expect(detectMailboxDraftRedirect('Here is the revised draft for Pam:')).toBeNull()
  })
})

describe('detectToolNameLeak', () => {
  it('flags the real leaked sentence from the Pam Ott incident', () => {
    expect(
      detectToolNameLeak(
        'Also — do you want this drafted into her Drafts folder, or should I stage it as a send_reply?',
        TOOL_NAMES
      )
    ).toBe('send_reply')
  })

  it('flags any tool name from the supplied list, whole-word only', () => {
    expect(detectToolNameLeak('Call confirm_pending_action once you say go.', TOOL_NAMES)).toBe(
      'confirm_pending_action'
    )
  })

  it('does not flag a tool name as a substring of a longer word', () => {
    expect(detectToolNameLeak('I already send_replyish this', ['send_reply'])).toBeNull()
  })

  it('treats external mailbox draft routing as forbidden even without a tool name', () => {
    expect(
      detectToolNameLeak('Want me to put it in your email drafts so you can attach something?', TOOL_NAMES)
    ).toMatch(/external mailbox|operator draft/i)
  })

  it('passes ordinary operator prose that never names a tool or redirects drafts', () => {
    expect(detectToolNameLeak('Here is the revised draft. Send that?', TOOL_NAMES)).toBeNull()
    expect(detectToolNameLeak('', TOOL_NAMES)).toBeNull()
  })

  it('is scoped to supplied tool names, not a general snake_case scan', () => {
    expect(detectToolNameLeak('Her code is BOOKING_REF_442.', TOOL_NAMES)).toBeNull()
  })
})

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
