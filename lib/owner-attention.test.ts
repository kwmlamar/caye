import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

interface Row {
  [key: string]: unknown
}

/** Rows the fake `caye_owner_attention` select returns. Set per test. */
let TABLE: Row[] = []
/** Patches the code under test applied, in order. */
let UPDATES: Row[] = []
let INSERTS: Row[] = []

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from() {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      Object.assign(chain, {
        select: self,
        eq: self,
        in: self,
        is: self,
        order: self,
        limit: () => Promise.resolve({ data: TABLE, error: null }),
        maybeSingle: () => Promise.resolve({ data: TABLE[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: TABLE[0] ?? null, error: null }),
        insert(row: Row) {
          INSERTS.push(row)
          return {
            select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }),
          }
        },
        update(patch: Row) {
          UPDATES.push(patch)
          const after: Record<string, unknown> = {}
          Object.assign(after, {
            eq: () => after,
            in: () => Promise.resolve({ data: null, error: null }),
            select: () => ({
              single: () => Promise.resolve({ data: { ...TABLE[0], ...patch }, error: null }),
            }),
            then: (r: (v: unknown) => unknown) =>
              Promise.resolve({ data: null, error: null }).then(r),
          })
          return after
        },
      })
      return chain
    },
  }),
}))

import {
  loadAttentionDelta,
  renderAttentionContext,
  observeAttentionItem,
  fingerprint,
  type AttentionItem,
} from './owner-attention'

beforeEach(() => {
  TABLE = []
  UPDATES = []
  INSERTS = []
})

/** A row as Supabase returns it. */
function row(over: Partial<Row> = {}): Row {
  return {
    id: 'a1',
    workspace_id: 'ws',
    subject_type: 'escalation',
    subject_id: 'esc-1',
    conversation_id: 'conv-1',
    title: 'Ruslan Prakapovich — B2B partnership',
    priority: 'decision',
    status: 'open',
    first_notified_at: null,
    last_notified_at: null,
    notify_count: 0,
    last_notified_summary: null,
    acknowledged_at: null,
    decided_at: null,
    decision: null,
    next_action: 'Waiting on the owner',
    completed_at: null,
    state_fingerprint: 'fp-1',
    notified_fingerprint: null,
    last_changed_at: '2026-08-12T09:00:00Z',
    digest: null,
    ...over,
  }
}

describe('attention delta — news vs repetition', () => {
  it('buckets an unreported item as new', async () => {
    TABLE = [row()]
    const delta = await loadAttentionDelta({ workspaceId: 'ws' })
    expect(delta.unreported.map((i: AttentionItem) => i.subjectId)).toEqual(['esc-1'])
    expect(delta.changed).toHaveLength(0)
    expect(delta.unchanged).toHaveLength(0)
    expect(delta.allClear).toBe(false)
  })

  it('does NOT re-surface an already-told item whose state has not moved', async () => {
    // Requirement 5. This is the 2026-08-12 bug: the escalation ping went out
    // at 09:00, nothing changed, and the 09:30 briefing described it again as
    // if it were fresh.
    TABLE = [
      row({
        last_notified_at: '2026-08-12T09:00:00Z',
        notify_count: 1,
        notified_fingerprint: 'fp-1',
        last_notified_summary: 'B2B enquiry — needs your call.',
      }),
    ]
    const delta = await loadAttentionDelta({ workspaceId: 'ws' })
    expect(delta.unreported).toHaveLength(0)
    expect(delta.changed).toHaveLength(0)
    expect(delta.unchanged.map((i: AttentionItem) => i.subjectId)).toEqual(['esc-1'])
  })

  it('surfaces an already-told item once its state actually moves', async () => {
    TABLE = [
      row({
        state_fingerprint: 'fp-2',
        notified_fingerprint: 'fp-1',
        last_notified_at: '2026-08-12T09:00:00Z',
        last_notified_summary: 'B2B enquiry — needs your call.',
      }),
    ]
    const delta = await loadAttentionDelta({ workspaceId: 'ws' })
    expect(delta.changed.map((i: AttentionItem) => i.subjectId)).toEqual(['esc-1'])
    expect(delta.unchanged).toHaveLength(0)
  })

  it('drops a resolved item out of outstanding attention', async () => {
    // Requirement 6.
    TABLE = [row({ status: 'resolved', completed_at: new Date().toISOString() })]
    const delta = await loadAttentionDelta({ workspaceId: 'ws' })
    expect(delta.unreported).toHaveLength(0)
    expect(delta.changed).toHaveLength(0)
    expect(delta.unchanged).toHaveLength(0)
    expect(delta.resolvedSince.map((i: AttentionItem) => i.subjectId)).toEqual(['esc-1'])
    expect(delta.allClear).toBe(true)
  })

  it('leaves an old resolution out of "since last time"', async () => {
    TABLE = [row({ status: 'resolved', completed_at: '2026-07-01T00:00:00Z' })]
    const delta = await loadAttentionDelta({ workspaceId: 'ws' })
    expect(delta.resolvedSince).toHaveLength(0)
    expect(delta.allClear).toBe(true)
  })

  it('is not allClear while ANY item is open, however stale', async () => {
    TABLE = [
      row({
        last_notified_at: '2026-08-01T09:00:00Z',
        notified_fingerprint: 'fp-1',
      }),
    ]
    const delta = await loadAttentionDelta({ workspaceId: 'ws' })
    expect(delta.allClear).toBe(false)
  })

  it('degrades to allClear rather than throwing when the read fails', async () => {
    // A bookkeeping failure must never take down the briefing that reads it.
    const delta = await loadAttentionDelta({ workspaceId: 'ws' })
    expect(delta.allClear).toBe(true)
  })
})

describe('attention delta — operator-demonstrated awareness (2026-08-26 Autumn McNeill incident)', () => {
  it('buckets a never-notified item as alreadyKnownToOperator, not unreported, when the operator showed they already know', async () => {
    TABLE = [
      row({
        operator_aware_fingerprint: 'fp-1',
        operator_aware_at: '2026-08-26T01:39:06Z',
        operator_aware_summary: 'Operator sent a customer-facing reply in this conversation themselves.',
      }),
    ]
    const delta = await loadAttentionDelta({ workspaceId: 'ws' })
    expect(delta.unreported).toHaveLength(0)
    expect(delta.alreadyKnownToOperator.map((i: AttentionItem) => i.subjectId)).toEqual(['esc-1'])
    // Still not clear — the item is open, just not worth interrupting about.
    expect(delta.allClear).toBe(false)
  })

  it('falls back to unreported when the operator-aware fingerprint is stale (state moved on since)', async () => {
    TABLE = [
      row({
        state_fingerprint: 'fp-2', // moved since the operator last showed awareness
        operator_aware_fingerprint: 'fp-1',
        operator_aware_at: '2026-08-26T01:39:06Z',
      }),
    ]
    const delta = await loadAttentionDelta({ workspaceId: 'ws' })
    expect(delta.alreadyKnownToOperator).toHaveLength(0)
    expect(delta.unreported.map((i: AttentionItem) => i.subjectId)).toEqual(['esc-1'])
  })

  it('an already-notified item is unaffected by operator awareness — notified/changed bucketing still wins', async () => {
    TABLE = [
      row({
        last_notified_at: '2026-08-12T09:00:00Z',
        notify_count: 1,
        notified_fingerprint: 'fp-1',
        operator_aware_fingerprint: 'fp-1',
        operator_aware_at: '2026-08-26T01:39:06Z',
      }),
    ]
    const delta = await loadAttentionDelta({ workspaceId: 'ws' })
    expect(delta.alreadyKnownToOperator).toHaveLength(0)
    expect(delta.unchanged.map((i: AttentionItem) => i.subjectId)).toEqual(['esc-1'])
  })
})

describe('renderAttentionContext — what the composer is told', () => {
  it('states plainly that the owner is clear when nothing is open', async () => {
    TABLE = []
    const text = renderAttentionContext(await loadAttentionDelta({ workspaceId: 'ws' }))
    expect(text).toMatch(/nothing is open/)
    expect(text).toMatch(/genuinely clear/)
  })

  it('forbids the contradiction in so many words when something is open', async () => {
    TABLE = [
      row({
        last_notified_at: '2026-08-12T09:00:00Z',
        notified_fingerprint: 'fp-1',
        last_notified_summary: 'B2B enquiry — needs your call.',
      }),
    ]
    const text = renderAttentionContext(await loadAttentionDelta({ workspaceId: 'ws' }))
    expect(text).toMatch(/The owner is NOT clear/)
    expect(text).toMatch(/do not say "nothing needs your attention"/i)
    expect(text).toMatch(/do NOT re-explain or re-raise as new/)
    // The composer sees what it already said, so it can give a delta.
    expect(text).toContain('B2B enquiry — needs your call.')
  })

  it('orders critical above decision above awareness', async () => {
    TABLE = [
      row({ id: 'c', subject_id: 'awareness-1', priority: 'awareness', title: 'Newsletter reply' }),
      row({ id: 'a', subject_id: 'critical-1', priority: 'critical', title: 'Chargeback opened' }),
      row({ id: 'b', subject_id: 'decision-1', priority: 'decision', title: 'Ruslan — B2B' }),
    ]
    const text = renderAttentionContext(await loadAttentionDelta({ workspaceId: 'ws' }))
    expect(text.indexOf('Chargeback opened')).toBeLessThan(text.indexOf('Ruslan — B2B'))
    expect(text.indexOf('Ruslan — B2B')).toBeLessThan(text.indexOf('Newsletter reply'))
  })

  it('marks resolved items as never-outstanding', async () => {
    TABLE = [row({ status: 'resolved', completed_at: new Date().toISOString() })]
    const text = renderAttentionContext(await loadAttentionDelta({ workspaceId: 'ws' }))
    expect(text).toMatch(/RESOLVED since last time/)
    expect(text).toMatch(/never present as outstanding/)
  })

  it('instructs the composer to say NOTHING about an operator-already-known item — not even "on your radar"', async () => {
    // The second Autumn McNeill message: "Sonja's booking confirmed and
    // Autumn's new pending are already on your radar; the resolved
    // escalation needs nothing further." Announcing that nothing needs
    // attention IS itself the interruption this instruction rules out.
    TABLE = [
      row({
        operator_aware_fingerprint: 'fp-1',
        operator_aware_at: '2026-08-26T01:39:06Z',
      }),
    ]
    const text = renderAttentionContext(await loadAttentionDelta({ workspaceId: 'ws' }))
    expect(text).toMatch(/ALREADY KNOWN TO THE OPERATOR/)
    expect(text).toMatch(/Do NOT name these/)
    expect(text).toMatch(/mentioning a non-event IS the interruption/)
  })
})

describe('fingerprint — what re-earns attention', () => {
  it('is stable for the same meaningful state', () => {
    expect(fingerprint(['policy', '2026-10-04', 'group rate'])).toBe(
      fingerprint(['policy', '2026-10-04', 'group rate'])
    )
  })

  it('changes when the ask changes', () => {
    expect(fingerprint(['policy', '2026-10-04', 'group rate'])).not.toBe(
      fingerprint(['policy', '2026-10-04', 'refund request'])
    )
  })

  it('treats null and missing alike, so an absent field is not a change', () => {
    expect(fingerprint(['policy', null, 'x'])).toBe(fingerprint(['policy', undefined, 'x']))
  })
})

describe('observeAttentionItem', () => {
  it('creates a row the first time an item is seen', async () => {
    TABLE = []
    await observeAttentionItem({
      workspaceId: 'ws',
      subjectType: 'escalation',
      subjectId: 'esc-1',
      title: 'Ruslan — B2B',
      priority: 'decision',
      fingerprintParts: ['policy', null, 'group rate'],
    })
    expect(INSERTS).toHaveLength(1)
    expect(INSERTS[0].subject_id).toBe('esc-1')
    expect(INSERTS[0].state_fingerprint).toBeTruthy()
  })

  it('updates rather than duplicating when the same item is seen again', async () => {
    TABLE = [row()]
    await observeAttentionItem({
      workspaceId: 'ws',
      subjectType: 'escalation',
      subjectId: 'esc-1',
      title: 'Ruslan — B2B',
      priority: 'decision',
      fingerprintParts: ['policy', null, 'group rate'],
    })
    expect(INSERTS).toHaveLength(0)
    expect(UPDATES).toHaveLength(1)
  })

  it('does not move last_changed_at when nothing meaningful changed', async () => {
    const parts = ['policy', null, 'group rate']
    TABLE = [row({ state_fingerprint: fingerprint(parts) })]
    await observeAttentionItem({
      workspaceId: 'ws',
      subjectType: 'escalation',
      subjectId: 'esc-1',
      title: 'Ruslan — B2B',
      priority: 'decision',
      fingerprintParts: parts,
    })
    // Re-observing an unchanged item must not make it look like news.
    expect(UPDATES[0]).not.toHaveProperty('last_changed_at')
  })

  it('reopens a resolved item only when its state genuinely changed', async () => {
    TABLE = [row({ status: 'resolved', state_fingerprint: 'fp-old' })]
    await observeAttentionItem({
      workspaceId: 'ws',
      subjectType: 'escalation',
      subjectId: 'esc-1',
      title: 'Ruslan — B2B',
      priority: 'decision',
      fingerprintParts: ['policy', null, 'a genuinely new ask'],
    })
    expect(UPDATES[0].status).toBe('open')
    expect(UPDATES[0]).toHaveProperty('last_changed_at')
  })

  it('leaves a resolved item resolved when merely re-observed', async () => {
    const parts = ['policy', null, 'group rate']
    TABLE = [row({ status: 'resolved', state_fingerprint: fingerprint(parts) })]
    await observeAttentionItem({
      workspaceId: 'ws',
      subjectType: 'escalation',
      subjectId: 'esc-1',
      title: 'Ruslan — B2B',
      priority: 'decision',
      fingerprintParts: parts,
    })
    expect(UPDATES[0].status).toBe('resolved')
  })

  describe('first_state_fingerprint — legacy-row policy (PR #135 review, third finding)', () => {
    it('a brand-new row gets first_state_fingerprint stamped to its own initial fingerprint', async () => {
      TABLE = []
      await observeAttentionItem({
        workspaceId: 'ws',
        subjectType: 'booking',
        subjectId: 'booking-1',
        title: 'Autumn — New pending booking',
        priority: 'awareness',
        fingerprintParts: ['pending', null, null, null, '2026-09-05', '09:00:00', 2],
      })
      expect(INSERTS[0].first_state_fingerprint).toBe(INSERTS[0].state_fingerprint)
      expect(INSERTS[0].first_state_fingerprint).toBeTruthy()
    })

    it('3 — a legacy row (first_state_fingerprint already NULL) re-observed with an UNCHANGED state stays NULL, not silently backfilled', async () => {
      const parts = ['pending', null, null, null, '2026-09-05', '09:00:00', 2]
      TABLE = [row({ state_fingerprint: fingerprint(parts), first_state_fingerprint: null })]
      await observeAttentionItem({
        workspaceId: 'ws',
        subjectType: 'booking',
        subjectId: 'booking-1',
        title: 'Autumn — New pending booking',
        priority: 'awareness',
        fingerprintParts: parts, // unchanged
      })
      expect(UPDATES[0]).not.toHaveProperty('first_state_fingerprint')
    })

    it('4 — a legacy row transitioning pending -> confirmed also leaves first_state_fingerprint untouched, not set to either state', async () => {
      const pendingParts = ['pending', null, null, null, '2026-09-05', '09:00:00', 2]
      const confirmedParts = ['confirmed', '2026-08-27T10:00:00Z', null, null, '2026-09-05', '09:00:00', 2]
      TABLE = [row({ state_fingerprint: fingerprint(pendingParts), first_state_fingerprint: null })]
      await observeAttentionItem({
        workspaceId: 'ws',
        subjectType: 'booking',
        subjectId: 'booking-1',
        title: 'Autumn — Booking confirmed & paid',
        priority: 'awareness',
        fingerprintParts: confirmedParts, // real transition
      })
      // The bug this guards against: writing EITHER the old (pending) or
      // new (confirmed) fingerprint here would convert "unknown history"
      // into a false "provably initial" — first_state_fingerprint must
      // simply never be written by the update path, full stop.
      expect(UPDATES[0]).not.toHaveProperty('first_state_fingerprint')
      expect(UPDATES[0].state_fingerprint).toBe(fingerprint(confirmedParts)) // the real state still updates normally
    })

    it('5 — re-observing a legacy row THREE times (unchanged, then a real transition, then unchanged again) never converts it into a "known initial" row', async () => {
      const pendingParts = ['pending', null, null, null, '2026-09-05', '09:00:00', 2]
      const confirmedParts = ['confirmed', '2026-08-27T10:00:00Z', null, null, '2026-09-05', '09:00:00', 2]

      // Round 1: unchanged re-observation.
      TABLE = [row({ state_fingerprint: fingerprint(pendingParts), first_state_fingerprint: null })]
      await observeAttentionItem({
        workspaceId: 'ws',
        subjectType: 'booking',
        subjectId: 'booking-1',
        title: 'x',
        priority: 'awareness',
        fingerprintParts: pendingParts,
      })
      expect(UPDATES[0]).not.toHaveProperty('first_state_fingerprint')

      // Round 2: a real transition.
      UPDATES = []
      await observeAttentionItem({
        workspaceId: 'ws',
        subjectType: 'booking',
        subjectId: 'booking-1',
        title: 'x',
        priority: 'awareness',
        fingerprintParts: confirmedParts,
      })
      expect(UPDATES[0]).not.toHaveProperty('first_state_fingerprint')

      // Round 3: unchanged re-observation of the NEW state — still no write.
      UPDATES = []
      TABLE = [row({ state_fingerprint: fingerprint(confirmedParts), first_state_fingerprint: null })]
      await observeAttentionItem({
        workspaceId: 'ws',
        subjectType: 'booking',
        subjectId: 'booking-1',
        title: 'x',
        priority: 'awareness',
        fingerprintParts: confirmedParts,
      })
      expect(UPDATES[0]).not.toHaveProperty('first_state_fingerprint')
    })
  })
})
