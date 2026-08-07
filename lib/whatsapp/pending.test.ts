import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({}) }))

import { pickProposedReply, resolveItemRef, type PendingHeldItem } from './pending'

describe('pickProposedReply — both draft stores', () => {
  it('finds the outreach draft on the conversation itself', () => {
    // create_outreach_leads writes here and creates NO internal message row.
    // Reading only the note is what produced "No draft on file for Oceans
    // Africa" for all 18 held outreach threads (2026-08-07).
    expect(pickProposedReply({ proposed_reply: 'Hey,\n\nOceans Africa runs on tides…' }, null)).toBe(
      'Hey,\n\nOceans Africa runs on tides…'
    )
  })

  it('finds the reply draft on the internal note', () => {
    expect(pickProposedReply(null, { proposed_reply: 'Happy to help — Tuesday works.' })).toBe(
      'Happy to help — Tuesday works.'
    )
  })

  it('prefers the conversation draft when both exist', () => {
    expect(pickProposedReply({ proposed_reply: 'newer' }, { proposed_reply: 'older' })).toBe('newer')
  })

  it('returns null for absent, blank, or non-string drafts', () => {
    expect(pickProposedReply(null, null)).toBeNull()
    expect(pickProposedReply({}, {})).toBeNull()
    expect(pickProposedReply({ proposed_reply: '   ' }, null)).toBeNull()
    expect(pickProposedReply({ proposed_reply: 42 }, null)).toBeNull()
    expect(pickProposedReply('not an object', undefined)).toBeNull()
  })
})

describe('resolveItemRef', () => {
  const items: PendingHeldItem[] = ['Oceans Africa', 'Kim', 'Fernando'].map((contactName, i) => ({
    index: i + 1,
    conversationId: `conv-${i + 1}`,
    contactName,
    channelType: 'email',
    reason: null,
    proposedReply: null,
    lastMessagePreview: null,
    lastMessageAt: null,
  }))

  it('resolves by index, position word, name, and conversation id', () => {
    expect(resolveItemRef(items, '2')?.contactName).toBe('Kim')
    expect(resolveItemRef(items, 'first')?.contactName).toBe('Oceans Africa')
    expect(resolveItemRef(items, 'last')?.contactName).toBe('Fernando')
    expect(resolveItemRef(items, 'kim')?.contactName).toBe('Kim')
    expect(resolveItemRef(items, 'conv-3')?.contactName).toBe('Fernando')
  })

  it('returns null rather than guessing when the ref is absent or unmatched', () => {
    // No silent fall-through to position 1 — that is the whole bug class.
    expect(resolveItemRef(items, undefined)).toBeNull()
    expect(resolveItemRef(items, 'Zanzibar')).toBeNull()
    expect(resolveItemRef(items, '9')).toBeNull()
  })

  it('resolves a missing ref only when there is exactly one item', () => {
    expect(resolveItemRef([items[0]], undefined)?.contactName).toBe('Oceans Africa')
  })
})
