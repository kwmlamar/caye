import { describe, it, expect } from 'vitest'
import {
  classifyAddress,
  identityFromConversation,
  identityFromField,
  mergeIdentities,
  summarizeReachability,
  classifyMatch,
  isRealCorrespondent,
  type Identity,
} from './customer-profile'

/**
 * GOLDEN SET — shapes captured from real production rows on 2026-08-08.
 *
 * Local-parts and domains of customer addresses are pseudonymized; every
 * structural property that drives a rule is preserved exactly: which columns
 * are null, whether contact_id exists, the Wix relay format, the daemon
 * addresses (kept verbatim — they are vendor infrastructure, not personal
 * data, and the literal string is what the rule matches).
 *
 * These cases exist because hand-written fixtures passed all night while
 * production was wrong. Each one below is a real row that broke something.
 */

// Zanzibar Holidays One — outreach workspace, 0% of threads have a contacts
// row. The address lives ONLY in unified_conversations.customer_id, which is
// the column dispatchOperatorReply had just sent to when Caye said she had no
// email for the thread.
const ZANZIBAR = {
  conversation_id: '169890d4-8adf-4159-b162-0bf9ac1b8df2',
  customer_name: 'Zanzibar Holidays One',
  customer_id: 'lead-a1@example-tours.com',
  contact_id: null,
  channel_type: 'email',
  last_message_at: '2026-08-08T03:54:34.941Z',
  contact_email: null,
}

// Charity Williams — Bimini. THREE conversations, three different addresses,
// three separate contacts rows, all one person. Every address is a per-
// submission Wix contact-form relay.
const CHARITY_ROWS = [
  {
    customer_id: '6f5c00b8-3926-45ee-b8bb-3b16aad07dbf@crm.wix.com',
    contact_email: '6f5c00b8-3926-45ee-b8bb-3b16aad07dbf@crm.wix.com',
    last_message_at: '2023-05-25T03:55:09.153Z',
  },
  {
    customer_id: '5b1cc9fc-0081-4d25-89f3-d6eb462707de@crm.wix.com',
    contact_email: '5b1cc9fc-0081-4d25-89f3-d6eb462707de@crm.wix.com',
    last_message_at: '2023-05-25T03:27:22.727Z',
  },
  {
    customer_id: 'reply-to+137aaf53b797@crm.wix.com',
    contact_email: 'reply-to+137aaf53b797@crm.wix.com',
    last_message_at: '2023-05-24T04:57:54.163Z',
  },
]

// Bounce daemons. Verbatim: these already have contacts rows in production
// (552b2607…, 0e42648e…), created before any gate existed.
const DAEMONS = ['mailer-daemon@googlemail.com', 'mailer-daemon@mail.zoho.com']

describe('golden: the address is in customer_id, not contacts', () => {
  it('finds Zanzibar\'s email with no contacts row at all', () => {
    const identity = identityFromConversation(
      ZANZIBAR.channel_type,
      ZANZIBAR.customer_id,
      ZANZIBAR.last_message_at
    )
    expect(identity).not.toBeNull()
    expect(identity!.address).toBe('lead-a1@example-tours.com')
    expect(identity!.kind).toBe('direct')
    expect(identity!.provenance).toBe('verified')

    const reach = summarizeReachability([identity!])
    expect(reach.emails).toHaveLength(1)
    // The exact failure: this must NOT report email as absent.
    expect(reach.absent).not.toContain('email')
  })

  it('reports phone as genuinely absent, not merely unfound', () => {
    const identity = identityFromConversation(ZANZIBAR.channel_type, ZANZIBAR.customer_id)!
    const reach = summarizeReachability([identity], { checked: ['email', 'phone'] })
    expect(reach.absent).toContain('phone')
    expect(reach.not_checked).toHaveLength(0)
  })

  it('separates "not fetched" from "absent"', () => {
    const identity = identityFromConversation(ZANZIBAR.channel_type, ZANZIBAR.customer_id)!
    const reach = summarizeReachability([identity], { checked: ['email'] })
    expect(reach.not_checked).toContain('phone')
    expect(reach.absent).not.toContain('phone')
  })
})

describe('golden: Wix relay addresses are not a customer\'s email', () => {
  it('classifies every Charity Williams address as a relay', () => {
    for (const row of CHARITY_ROWS) {
      expect(classifyAddress(row.customer_id)).toBe('relay')
    }
  })

  it('answers "no email on file" rather than three UUID strings', () => {
    const identities = CHARITY_ROWS.map((r) =>
      identityFromConversation('email', r.customer_id, r.last_message_at)
    )
    const reach = summarizeReachability(mergeIdentities(identities))

    expect(reach.emails).toHaveLength(0)
    expect(reach.absent).toContain('email')
    // …but the relays are still surfaced, because replying to them reaches her.
    expect(reach.relay_only).toHaveLength(3)
  })

  it('does not merge three relay addresses into one identity', () => {
    // They are one person, but nothing in the DATA says so — joining them
    // would be a name-based merge, which is how one customer ends up seeing
    // another's history. Only an operator may make that call.
    const merged = mergeIdentities(
      CHARITY_ROWS.map((r) => identityFromConversation('email', r.customer_id, r.last_message_at))
    )
    expect(merged).toHaveLength(3)
  })
})

describe('golden: bounce daemons are not customers', () => {
  it.each(DAEMONS)('classifies %s as automated', (address) => {
    expect(classifyAddress(address)).toBe('automated')
    expect(isRealCorrespondent('email', address)).toBe(false)
  })

  it('excludes daemons from reachability even when a contacts row exists', () => {
    // Production has contacts rows for these; a stored row must not launder a
    // daemon into a real address.
    const identity = identityFromField('email', DAEMONS[1], 'verified')!
    const reach = summarizeReachability([identity])
    expect(reach.emails).toHaveLength(0)
    expect(reach.absent).toContain('email')
  })

  it('still treats a real lead as a real correspondent', () => {
    expect(isRealCorrespondent('email', ZANZIBAR.customer_id)).toBe(true)
  })
})

describe('golden: merging and provenance', () => {
  it('merges the same address across sources and keeps the strongest provenance', () => {
    const merged = mergeIdentities([
      identityFromField('email', 'lead-a1@example-tours.com', 'claimed', '2026-08-01T00:00:00Z'),
      identityFromConversation('email', 'lead-a1@example-tours.com', '2026-08-08T03:54:34.941Z'),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].provenance).toBe('verified')
    expect(merged[0].last_seen).toBe('2026-08-08T03:54:34.941Z')
  })

  it('keeps a form-claimed address that differs from the thread address', () => {
    // get_customer used `inferredEmail ?? intake?.email`, so a form address
    // was silently outranked and never shown. Both are kept — the difference
    // is usually the useful signal.
    const merged = mergeIdentities([
      identityFromConversation('email', 'booked-via@example-agency.com', '2026-08-08T00:00:00Z'),
      identityFromField('email', 'guest-direct@example.com', 'claimed'),
    ])
    expect(merged).toHaveLength(2)
    expect(merged.map((i) => i.provenance)).toEqual(['verified', 'claimed'])
  })

  it('is case-insensitive on address but preserves what was stored', () => {
    const merged = mergeIdentities([
      identityFromConversation('email', 'Lead-A1@Example-Tours.com', '2026-08-01T00:00:00Z'),
      identityFromConversation('email', 'lead-a1@example-tours.com', '2026-08-08T00:00:00Z'),
    ])
    expect(merged).toHaveLength(1)
  })

  it('never reports a Messenger page-scoped id as a phone number', () => {
    expect(identityFromConversation('messenger', '7281994531828746')).toBeNull()
    expect(identityFromConversation('instagram', '17841400008460056')).toBeNull()
  })

  it('reads a WhatsApp thread id as a phone', () => {
    const identity = identityFromConversation('whatsapp', '12425551234')!
    expect(identity.channel).toBe('whatsapp')
    const reach = summarizeReachability([identity])
    expect(reach.phones).toHaveLength(1)
    expect(reach.absent).toContain('email')
  })
})

describe('golden: ambiguity carries no primary', () => {
  const candidates: Identity[] = CHARITY_ROWS.map(
    (r) => identityFromConversation('email', r.customer_id, r.last_message_at)!
  )

  it('returns all candidates and no single contact', () => {
    const outcome = classifyMatch(candidates)
    expect(outcome.match).toBe('ambiguous')
    // There is deliberately no `contact` key to latch onto.
    expect(outcome).not.toHaveProperty('contact')
    expect(outcome.match === 'ambiguous' && outcome.candidates).toHaveLength(3)
  })

  it('resolves cleanly when there is exactly one', () => {
    const outcome = classifyMatch([candidates[0]])
    expect(outcome.match).toBe('unique')
    expect(outcome.match === 'unique' && outcome.contact).toBe(candidates[0])
  })

  it('reports none rather than inventing a match', () => {
    expect(classifyMatch([]).match).toBe('none')
  })
})
