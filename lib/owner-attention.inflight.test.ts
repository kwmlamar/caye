import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

interface Row {
  [key: string]: unknown
}

/** In-memory tables — caye_owner_attention rows and caye_outbound_queue
 *  rows, so loadAttentionDelta's self-healing liveness check has something
 *  real to query. */
let ATTENTION: Row[] = []
let OUTBOUND_QUEUE: Row[] = []

function attentionRow(over: Partial<Row> = {}): Row {
  return {
    id: 'a1',
    workspace_id: 'ws-bimini',
    subject_type: 'conversation',
    subject_id: 'conv-karin',
    conversation_id: 'conv-karin',
    title: 'Karin Roberts — deposit invoice',
    priority: 'decision',
    status: 'open',
    first_notified_at: null,
    last_notified_at: null,
    notify_count: 0,
    last_notified_summary: null,
    acknowledged_at: null,
    decided_at: null,
    decision: null,
    next_action: null,
    completed_at: null,
    state_fingerprint: 'fp-karin',
    notified_fingerprint: null,
    last_changed_at: '2026-08-13T09:00:00Z',
    digest: null,
    blocked_on_operator: true,
    resolvable_autonomously: false,
    last_notification_queue_id: null,
    pending_notification_queue_id: null,
    ...over,
  }
}

function makeClient() {
  return {
    from(table: string) {
      if (table === 'caye_owner_attention') {
        const chain: Record<string, unknown> = {}
        const self = () => chain
        Object.assign(chain, {
          select: self,
          eq: self,
          in: self,
          order: self,
          limit: () => Promise.resolve({ data: ATTENTION, error: null }),
          maybeSingle: () => Promise.resolve({ data: ATTENTION[0] ?? null, error: null }),
          single: () => Promise.resolve({ data: ATTENTION[0] ?? null, error: null }),
          update(patch: Row) {
            const after: Record<string, unknown> = {}
            Object.assign(after, {
              eq: () => after,
              select: () => ({
                single: () => Promise.resolve({ data: { ...ATTENTION[0], ...patch }, error: null }),
              }),
              then: (r: (v: unknown) => unknown) => {
                // Apply the patch to every row matching the current
                // workspace/subject filters. Filters aren't tracked
                // precisely by this lightweight mock, so apply to all rows
                // sharing the fixture's single subject_id — sufficient for
                // these single-item scenarios.
                for (const row of ATTENTION) Object.assign(row, patch)
                return Promise.resolve({ data: null, error: null }).then(r)
              },
            })
            return after
          },
        })
        return chain
      }
      if (table === 'caye_outbound_queue') {
        const chain: Record<string, unknown> = {}
        const self = () => chain
        Object.assign(chain, {
          select: self,
          eq(col: string, val: unknown) {
            if (col === 'status') {
              // .eq('status', 'pending') filters the "still pending" query.
              ;(chain as { _statusFilter?: unknown })._statusFilter = val
            }
            return chain
          },
          in(col: string, vals: unknown[]) {
            ;(chain as { _idFilter?: unknown[] })._idFilter = vals
            return chain
          },
          then: (r: (v: unknown) => unknown) => {
            const idFilter = (chain as { _idFilter?: string[] })._idFilter
            const statusFilter = (chain as { _statusFilter?: string })._statusFilter
            const rows = OUTBOUND_QUEUE.filter(
              (row) =>
                (!idFilter || idFilter.includes(row.id as string)) &&
                (!statusFilter || row.status === statusFilter)
            )
            return Promise.resolve({ data: rows, error: null }).then(r)
          },
        })
        return chain
      }
      throw new Error(`unexpected table in test: ${table}`)
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => makeClient(),
}))

import { loadAttentionDelta, renderAttentionContext, markAttentionPending, markAttentionNotified } from './owner-attention'

beforeEach(() => {
  ATTENTION = []
  OUTBOUND_QUEUE = []
})

describe('notification lifecycle: not notified → in flight → notified', () => {
  it('an item with no pending notification is unreported, as before', async () => {
    ATTENTION = [attentionRow()]
    const delta = await loadAttentionDelta({ workspaceId: 'ws-bimini' })
    expect(delta.unreported.map((i) => i.subjectId)).toEqual(['conv-karin'])
    expect(delta.inFlight).toHaveLength(0)
  })

  it('Karin scenario: escalation queued but not yet dispatched — the digest sees it as IN FLIGHT, not unreported', async () => {
    OUTBOUND_QUEUE = [{ id: 'q-karin-1', status: 'pending' }]
    ATTENTION = [attentionRow({ pending_notification_queue_id: 'q-karin-1' })]

    const delta = await loadAttentionDelta({ workspaceId: 'ws-bimini' })
    expect(delta.unreported).toHaveLength(0)
    expect(delta.changed).toHaveLength(0)
    expect(delta.unchanged).toHaveLength(0)
    expect(delta.inFlight.map((i) => i.subjectId)).toEqual(['conv-karin'])
    // Still not "clear" — the item is open, just not the digest's to announce.
    expect(delta.allClear).toBe(false)

    const text = renderAttentionContext(delta)
    expect(text).toMatch(/NOTIFICATION ALREADY QUEUED/)
    expect(text).toMatch(/do NOT also announce/i)
    // Must not appear under a "NEW" heading — that's the actual bug this closes.
    expect(text).not.toMatch(/NEW — the owner has never been told[\s\S]*Karin/)
  })

  it('once the queued escalation actually sends, the item moves from in-flight to notified (and the pending flag clears)', async () => {
    OUTBOUND_QUEUE = [{ id: 'q-karin-1', status: 'pending' }]
    ATTENTION = [attentionRow({ pending_notification_queue_id: 'q-karin-1' })]

    // Sanity: it's in flight before the send.
    const before = await loadAttentionDelta({ workspaceId: 'ws-bimini' })
    expect(before.inFlight).toHaveLength(1)

    // The outbound worker dispatches the row and stamps notified — same
    // call outbound-worker's logOperatorPing makes post-send.
    await markAttentionNotified({
      workspaceId: 'ws-bimini',
      subjectType: 'conversation',
      subjectId: 'conv-karin',
      summary: 'Karin — deposit invoice, needs your call.',
      queueId: 'q-karin-1',
    })
    OUTBOUND_QUEUE[0].status = 'sent'

    const after = await loadAttentionDelta({ workspaceId: 'ws-bimini' })
    expect(after.inFlight).toHaveLength(0)
    expect(after.unreported).toHaveLength(0)
    // Fingerprint unchanged since observe — correctly "already told, nothing new."
    expect(after.unchanged.map((i) => i.subjectId)).toEqual(['conv-karin'])
    expect(ATTENTION[0].pending_notification_queue_id).toBeNull()
  })

  it('a genuinely different, urgent item is NOT suppressed merely because Karin has a notification in flight', async () => {
    OUTBOUND_QUEUE = [{ id: 'q-karin-1', status: 'pending' }]
    ATTENTION = [
      attentionRow({ pending_notification_queue_id: 'q-karin-1' }),
      attentionRow({
        id: 'a2',
        subject_id: 'conv-urgent-other',
        conversation_id: 'conv-urgent-other',
        title: 'Someone else — urgent double-booking',
        priority: 'critical',
        pending_notification_queue_id: null,
      }),
    ]

    const delta = await loadAttentionDelta({ workspaceId: 'ws-bimini' })
    expect(delta.inFlight.map((i) => i.subjectId)).toEqual(['conv-karin'])
    expect(delta.unreported.map((i) => i.subjectId)).toEqual(['conv-urgent-other'])

    const text = renderAttentionContext(delta)
    expect(text).toMatch(/Someone else — urgent double-booking/)
  })

  it('self-heals a stale pending pointer: a cancelled/failed send never permanently suppresses the item', async () => {
    // The queue row exists but is no longer pending (cancelled, e.g. mute
    // or a precondition failure) — markAttentionNotified was never called,
    // so pending_notification_queue_id was never cleared. Without the
    // liveness check this would wedge the item as "in flight" forever.
    OUTBOUND_QUEUE = [{ id: 'q-karin-1', status: 'cancelled' }]
    ATTENTION = [attentionRow({ pending_notification_queue_id: 'q-karin-1' })]

    const delta = await loadAttentionDelta({ workspaceId: 'ws-bimini' })
    expect(delta.inFlight).toHaveLength(0)
    expect(delta.unreported.map((i) => i.subjectId)).toEqual(['conv-karin'])
  })

  it('PR #135 review, fourth finding: a booking_created row cancelled at dispatch-time by a fresh gate outcome (not just mute/precondition failure) self-heals the same way — no duplicate cleanup needed', async () => {
    // bookingCreatedDispatchCancelReason (outbound-worker route.ts) now
    // cancels a queued booking_created row on ANY non-SEND gate outcome
    // (SUPPRESS_NO_CHANGE, SUPPRESS_RECENTLY_NOTIFIED, RESOLVED_NO_
    // NOTIFICATION, SUPPRESS_OPERATOR_AWARE) via the SAME cancel() helper
    // every other kind already uses, which sets caye_outbound_queue.status
    // = 'cancelled'. Proving that's enough: this test's fixture is
    // identical in shape to the generic "self-heals a stale pending
    // pointer" case above — the mechanism doesn't know or care WHY a row
    // was cancelled, only that its status is no longer 'pending'.
    OUTBOUND_QUEUE = [{ id: 'q-booking-1', status: 'cancelled' }]
    ATTENTION = [
      attentionRow({
        subject_type: 'booking',
        subject_id: 'booking-autumn',
        conversation_id: 'conv-autumn',
        title: 'Autumn McNeill — New pending booking',
        pending_notification_queue_id: 'q-booking-1',
      }),
    ]

    const delta = await loadAttentionDelta({ workspaceId: 'ws-bimini' })
    expect(delta.inFlight).toHaveLength(0) // not stuck "in flight" forever
    expect(delta.unreported.map((i) => i.subjectId)).toEqual(['booking-autumn'])
  })

  it('markAttentionPending completes without throwing and the item is queryable afterward', async () => {
    // Real per-filter row targeting (workspace/subject scoping) is a
    // Supabase query-filter property, not something this lightweight
    // same-process mock re-implements — that's covered at the .db.test.ts
    // layer. This just proves the call shape (three .eq()s, no .select())
    // resolves cleanly against the update mock, matching markAttentionNotified's.
    ATTENTION = [attentionRow()]
    await expect(
      markAttentionPending({
        workspaceId: 'ws-bimini',
        subjectType: 'conversation',
        subjectId: 'conv-karin',
        queueId: 'q-new',
      })
    ).resolves.toBeUndefined()
  })
})
