import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fingerprint } from '@/lib/owner-attention'

vi.mock('server-only', () => ({}))

interface Row {
  [key: string]: unknown
}

// decideOperatorNotification always recomputes state_fingerprint from the
// CALL's fingerprintParts via the real fingerprint() hash — a literal
// placeholder string like 'fp-1' can never match that, so every seeded row
// below uses the actual hash of karinInput's fingerprintParts as the
// "unchanged" baseline. Using anything else here silently makes every
// scenario read as a material change, which is exactly the bug this comment
// is here to stop someone reintroducing.
const FP_KARIN = fingerprint(['policy', '2026-11-06', 'deposit invoice'])

/** In-memory tables. Each test sets these to represent the ledger's CURRENT
 *  state at the moment decideOperatorNotification is called — the same way
 *  a real caller sees a snapshot shaped by whatever happened before. */
let ATTENTION: Row[] = []
let OPERATOR_MESSAGES: Row[] = []
let OUTBOUND_QUEUE: Row[] = []
let ATTENTION_INSERTS: Row[] = []
let ATTENTION_UPDATES: Row[] = []
let RESOLVE_CALLS: Row[] = []

// hasOperatorParticipatedInConversation's own evidence-window arithmetic
// (lookback buffer vs strict cutoff, upper-bound behavior) is unit-tested
// directly in operator-participation.test.ts. Mocked here so the
// SUPPRESS_OPERATOR_AWARE tests below can assert what the GATE decides to
// ask for (which mode, anchored to which timestamp) without depending on
// the real wall clock.
const { hasOperatorParticipatedInConversation } = vi.hoisted(() => ({
  hasOperatorParticipatedInConversation: vi.fn(),
}))
vi.mock('./operator-participation', () => ({ hasOperatorParticipatedInConversation }))

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
    state_fingerprint: FP_KARIN,
    notified_fingerprint: null,
    last_changed_at: '2026-08-13T09:00:00Z',
    digest: null,
    blocked_on_operator: true,
    resolvable_autonomously: false,
    last_notification_queue_id: null,
    ...over,
  }
}

function passthroughChain(get: () => Row[]) {
  const chain: Record<string, unknown> = {}
  const self = () => chain
  Object.assign(chain, {
    select: self,
    eq: self,
    in: self,
    gte: self,
    order: self,
    limit: () => Promise.resolve({ data: get(), error: null }),
    maybeSingle: () => Promise.resolve({ data: get()[0] ?? null, error: null }),
    single: () => Promise.resolve({ data: get()[0] ?? null, error: null }),
  })
  return chain
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
          insert(row: Row) {
            ATTENTION_INSERTS.push(row)
            return {
              select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }),
            }
          },
          update(patch: Row) {
            ATTENTION_UPDATES.push(patch)
            // Mutates ATTENTION[0] in place — decideOperatorNotification now
            // does a read-modify-write-then-separately-re-read sequence
            // within ONE call (observeAttentionItem's own update, then
            // recordOperatorAwareness's independent select+update), and a
            // snapshot-only mock would let the second read see stale data a
            // real DB never would. Single-row scenario, matching every
            // existing test's seed shape.
            if (ATTENTION[0]) Object.assign(ATTENTION[0], patch)
            const after: Record<string, unknown> = {}
            Object.assign(after, {
              eq: () => after,
              select: () => ({
                single: () => Promise.resolve({ data: { ...ATTENTION[0], ...patch }, error: null }),
              }),
              then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r),
            })
            return after
          },
        })
        return chain
      }
      if (table === 'caye_operator_messages') return passthroughChain(() => OPERATOR_MESSAGES)
      if (table === 'caye_outbound_queue') return passthroughChain(() => OUTBOUND_QUEUE)
      throw new Error(`unexpected table in test: ${table}`)
    },
  }
}

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => makeClient(),
}))

// setAttentionStatus/resolve calls go through the real owner-attention.ts —
// track them by watching ATTENTION_UPDATES (real module, not mocked) plus a
// spy for clarity in the RESOLVED_NO_NOTIFICATION tests.
vi.mock('@/lib/owner-attention', async () => {
  const actual = await vi.importActual<typeof import('@/lib/owner-attention')>('@/lib/owner-attention')
  return {
    ...actual,
    setAttentionStatus: vi.fn((args: Row) => {
      RESOLVE_CALLS.push(args)
      return actual.setAttentionStatus(args as Parameters<typeof actual.setAttentionStatus>[0])
    }),
  }
})

import { decideOperatorNotification } from './operator-notification-gate'

beforeEach(() => {
  ATTENTION = []
  OPERATOR_MESSAGES = []
  OUTBOUND_QUEUE = []
  ATTENTION_INSERTS = []
  ATTENTION_UPDATES = []
  RESOLVE_CALLS = []
  hasOperatorParticipatedInConversation.mockReset()
})

const karinInput = {
  workspaceId: 'ws-bimini',
  subjectType: 'conversation',
  subjectId: 'conv-karin',
  title: 'Karin Roberts — deposit invoice',
  priority: 'decision' as const,
  fingerprintParts: ['policy', '2026-11-06', 'deposit invoice'],
  blockedOnOperator: true,
  resolvableAutonomously: false,
}

describe('the Karin scenario (brief §13, steps A–I)', () => {
  it('A/B — a brand-new item sends', async () => {
    ATTENTION = []
    const decision = await decideOperatorNotification(karinInput)
    expect(decision.outcome).toBe('SEND_NEW')
    expect(ATTENTION_INSERTS).toHaveLength(1)
  })

  it('C/D/E/F — read but unanswered, nothing changed: repeated scans/jobs within the reminder window stay silent', async () => {
    ATTENTION = [
      attentionRow({
        last_notified_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(), // 20 min ago
        notify_count: 1,
        notified_fingerprint: FP_KARIN,
      }),
    ]
    // Three separate jobs "run" — each is just another call to the gate
    // with the same unchanged fingerprint.
    for (let i = 0; i < 3; i++) {
      const decision = await decideOperatorNotification(karinInput)
      expect(decision.outcome).toBe('SUPPRESS_RECENTLY_NOTIFIED')
    }
  })

  it('G — a concise reminder may fire once the decision-blocking threshold (hours, not minutes) has passed', async () => {
    ATTENTION = [
      attentionRow({
        last_notified_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), // 6h ago
        notify_count: 1,
        notified_fingerprint: FP_KARIN,
      }),
    ]
    const decision = await decideOperatorNotification(karinInput)
    expect(decision.outcome).toBe('SEND_REMINDER')
  })

  it('a 20-minute-old unresolved decision item does NOT yet earn a reminder', async () => {
    ATTENTION = [
      attentionRow({
        last_notified_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        notify_count: 1,
        notified_fingerprint: FP_KARIN,
      }),
    ]
    const decision = await decideOperatorNotification(karinInput)
    expect(decision.outcome).toBe('SUPPRESS_RECENTLY_NOTIFIED')
  })

  it('H — a material change (Karin\'s frustrated follow-up) bypasses the reminder interval entirely, even 20 minutes later', async () => {
    ATTENTION = [
      attentionRow({
        last_notified_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        notify_count: 1,
        state_fingerprint: 'fp-2', // the underlying ask/urgency changed
        notified_fingerprint: FP_KARIN,
      }),
    ]
    const decision = await decideOperatorNotification({
      ...karinInput,
      fingerprintParts: ['policy', '2026-11-06', 'deposit invoice — second follow-up'],
    })
    expect(decision.outcome).toBe('SEND_NEW')
    expect(decision.isMaterialChange).toBe(true)
  })

  it('I — Caye gaining the ability to resolve it herself closes the item instead of pinging the operator', async () => {
    ATTENTION = [attentionRow({ notify_count: 1, notified_fingerprint: FP_KARIN })]
    const decision = await decideOperatorNotification({
      ...karinInput,
      blockedOnOperator: false,
      resolvableAutonomously: true,
    })
    expect(decision.outcome).toBe('RESOLVED_NO_NOTIFICATION')
    expect(RESOLVE_CALLS.some((c) => c.status === 'resolved')).toBe(true)
  })
})

describe('operator acknowledgement suppresses reminders regardless of elapsed time', () => {
  it('an acknowledged, unchanged item stays silent even well past the reminder threshold', async () => {
    ATTENTION = [
      attentionRow({
        status: 'acknowledged',
        last_notified_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 24h ago
        notify_count: 1,
        notified_fingerprint: FP_KARIN,
      }),
    ]
    const decision = await decideOperatorNotification(karinInput)
    expect(decision.outcome).toBe('SUPPRESS_NO_CHANGE')
  })

  it('but a material change still reopens an acknowledged item', async () => {
    ATTENTION = [
      attentionRow({
        status: 'acknowledged',
        state_fingerprint: 'fp-2',
        last_notified_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        notify_count: 1,
        notified_fingerprint: FP_KARIN,
      }),
    ]
    const decision = await decideOperatorNotification({
      ...karinInput,
      fingerprintParts: ['policy', '2026-11-06', 'a genuinely different ask'],
    })
    expect(decision.outcome).toBe('SEND_NEW')
  })
})

describe('resolved / dismissed items never keep generating reminders', () => {
  it('a resolved item with no change stays resolved', async () => {
    ATTENTION = [attentionRow({ status: 'resolved', notify_count: 1, notified_fingerprint: FP_KARIN })]
    const decision = await decideOperatorNotification(karinInput)
    expect(decision.outcome).toBe('RESOLVED_NO_NOTIFICATION')
  })
})

describe('priority-scoped reminder cadence', () => {
  it('a critical item earns a reminder well before a decision item would (~1-2h, not ~4-6h)', async () => {
    ATTENTION = [
      attentionRow({
        priority: 'critical',
        last_notified_at: new Date(Date.now() - 100 * 60 * 1000).toISOString(), // 100 min
        notify_count: 1,
        notified_fingerprint: FP_KARIN,
      }),
    ]
    const decision = await decideOperatorNotification({ ...karinInput, priority: 'critical' })
    expect(decision.outcome).toBe('SEND_REMINDER')
  })

  it('a non-blocking decision item waits longer than a blocking one before reminding', async () => {
    ATTENTION = [
      attentionRow({
        last_notified_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(), // 6h — enough for blocking, not for ordinary
        notify_count: 1,
        notified_fingerprint: FP_KARIN,
      }),
    ]
    const decision = await decideOperatorNotification({ ...karinInput, blockedOnOperator: false })
    expect(decision.outcome).toBe('SUPPRESS_RECENTLY_NOTIFIED')
  })

  it('awareness-tier items never auto-remind, however stale', async () => {
    ATTENTION = [
      attentionRow({
        priority: 'awareness',
        last_notified_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        notify_count: 1,
        notified_fingerprint: FP_KARIN,
      }),
    ]
    const decision = await decideOperatorNotification({
      ...karinInput,
      priority: 'awareness',
      blockedOnOperator: false,
    })
    expect(decision.outcome).toBe('SUPPRESS_NO_CHANGE')
  })
})

describe('read receipts inform pacing but never speed it up', () => {
  it('a read-but-unanswered non-blocking item is held to at least the normal threshold, never less', async () => {
    ATTENTION = [
      attentionRow({
        last_notification_queue_id: 'q-1',
        last_notified_at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(), // past the un-read 8h ordinary threshold minus a bit
        notify_count: 1,
        notified_fingerprint: FP_KARIN,
      }),
    ]
    OUTBOUND_QUEUE = [{ id: 'q-1', wa_delivery_status: 'read' }]
    const decision = await decideOperatorNotification({ ...karinInput, blockedOnOperator: false })
    // 7h < 8h*1.5 lengthened threshold — still suppressed, never fired early because of the read receipt.
    expect(decision.outcome).toBe('SUPPRESS_RECENTLY_NOTIFIED')
  })
})

describe('two unrelated issues both surface independently', () => {
  it('a second, never-seen-before subject sends on its own — Karin\'s state doesn\'t block Christina\'s', async () => {
    // No row for conv-christina yet (Karin's row, if any, would be a
    // different subject_id and isn't what this call looks up).
    ATTENTION = []
    const decision = await decideOperatorNotification({
      ...karinInput,
      subjectId: 'conv-christina',
      title: 'Christina Masters — booking confirmed',
      priority: 'awareness',
      blockedOnOperator: false,
    })
    expect(decision.outcome).toBe('SEND_NEW')
  })
})

describe('informational updates are treated as such by callers, not as action items', () => {
  it('an awareness-tier new item still SENDs once (an FYI is worth saying), just never auto-reminds after', async () => {
    ATTENTION = []
    const decision = await decideOperatorNotification({
      ...karinInput,
      subjectType: 'scan_finding',
      subjectId: 'finding-1',
      priority: 'awareness',
      blockedOnOperator: false,
    })
    expect(decision.outcome).toBe('SEND_NEW')
  })
})

describe('workspace scoping', () => {
  it('a brand-new item is registered under the calling workspace, not a default/shared one', async () => {
    ATTENTION = []
    await decideOperatorNotification({ ...karinInput, workspaceId: 'ws-other' })
    expect(ATTENTION_INSERTS).toHaveLength(1)
    expect(ATTENTION_INSERTS[0].workspace_id).toBe('ws-other')
  })
})

// The Autumn McNeill scenario (2026-08-26 Bimini incident): Mrs. Max pulled
// Autumn's thread, drafted/edited/sent the reply herself, and told Caye
// directly she'd handled it. booking_created still pinged her ~9.5h later.
// operatorParticipationCheck is the fix — see lib/whatsapp/triggers.ts and
// lib/whatsapp/operator-participation.ts.
describe('SUPPRESS_OPERATOR_AWARE — structural operator-participation evidence (Autumn McNeill, 2026-08-26)', () => {
  // hasOperatorParticipatedInConversation itself (the evidence-window
  // arithmetic — lookback buffer, no-buffer, upper bound) is exhaustively
  // unit-tested in operator-participation.test.ts. This file mocks it
  // directly so these tests can assert what the GATE decides to ask for —
  // which mode, anchored to which timestamp — without depending on the
  // real wall clock (last_changed_at on a freshly-observed row is always
  // "now", which a fixed historical fixture can't reliably straddle).
  const autumnInput = {
    workspaceId: 'ws-bimini',
    subjectType: 'booking',
    subjectId: 'booking-autumn',
    conversationId: 'conv-autumn',
    title: 'Autumn McNeill — New pending booking',
    priority: 'awareness' as const,
    fingerprintParts: ['pending', null, null, null, '2026-09-05', '09:00:00', 2],
    blockedOnOperator: false,
    resolvableAutonomously: false,
    operatorParticipationCheck: { conversationId: 'conv-autumn' },
  }
  const FP_AUTUMN = fingerprint(autumnInput.fingerprintParts)
  const FP_CONFIRMED_PAID = fingerprint(['confirmed', '2026-08-27T10:00:00Z', null, null, '2026-09-05', '09:00:00', 2])
  const FP_NEW_TIME = fingerprint(['pending', null, null, null, '2026-09-05', '11:00:00', 2])

  it('1 — Autumn original: a brand-new booking never sends when the operator already handled that exact conversation ("initial" mode)', async () => {
    ATTENTION = []
    hasOperatorParticipatedInConversation.mockResolvedValue(true)
    const decision = await decideOperatorNotification(autumnInput)
    expect(decision.outcome).toBe('SUPPRESS_OPERATOR_AWARE')
    // Brand new subject: first_state_fingerprint === state_fingerprint (both
    // just set to FP_AUTUMN on insert) => 'initial' mode.
    expect(hasOperatorParticipatedInConversation).toHaveBeenCalledWith('conv-autumn', expect.any(String), 'initial')
  })

  it('stamps operator_aware_fingerprint to the current state so the awareness is auditable and re-comparable later', async () => {
    ATTENTION = [
      attentionRow({
        subject_type: 'booking',
        subject_id: 'booking-autumn',
        conversation_id: 'conv-autumn',
        state_fingerprint: FP_AUTUMN,
        first_state_fingerprint: FP_AUTUMN,
        notify_count: 0,
        notified_fingerprint: null,
        operator_aware_fingerprint: null,
        operator_aware_at: null,
      }),
    ]
    hasOperatorParticipatedInConversation.mockResolvedValue(true)
    const decision = await decideOperatorNotification(autumnInput)
    expect(decision.outcome).toBe('SUPPRESS_OPERATOR_AWARE')
    const stamp = ATTENTION_UPDATES.find((u) => u.operator_aware_fingerprint)
    expect(stamp?.operator_aware_fingerprint).toBe(FP_AUTUMN)
  })

  it('2 — operator handled the pending booking 20 minutes ago; payment confirms NOW => that old participation must NOT suppress the new state', async () => {
    // A real transition: the ledger already has a DIFFERENT prior
    // fingerprint (the pending state) — first_state_fingerprint stays
    // pinned to that original pending value while state_fingerprint moves
    // to the confirmed+paid one, so first !== state => 'post-transition'.
    // hasOperatorParticipatedInConversation is mocked to return exactly
    // what a real strict-cutoff query would for 20-minutes-stale evidence:
    // false — proving the OLD participation cannot cover the NEW state.
    ATTENTION = [
      attentionRow({
        subject_type: 'booking',
        subject_id: 'booking-autumn',
        conversation_id: 'conv-autumn',
        state_fingerprint: FP_AUTUMN,
        first_state_fingerprint: FP_AUTUMN,
        notify_count: 0,
        notified_fingerprint: null,
      }),
    ]
    hasOperatorParticipatedInConversation.mockResolvedValue(false)
    const decision = await decideOperatorNotification({
      ...autumnInput,
      fingerprintParts: ['confirmed', '2026-08-27T10:00:00Z', null, null, '2026-09-05', '09:00:00', 2],
    })
    expect(decision.outcome).toBe('SEND_NEW')
    expect(hasOperatorParticipatedInConversation).toHaveBeenCalledWith('conv-autumn', expect.any(String), 'post-transition')
  })

  it('3 — operator handles the conversation AFTER payment confirmation => the confirmed/paid state may be marked operator-aware', async () => {
    ATTENTION = [
      attentionRow({
        subject_type: 'booking',
        subject_id: 'booking-autumn',
        conversation_id: 'conv-autumn',
        state_fingerprint: FP_AUTUMN,
        first_state_fingerprint: FP_AUTUMN,
        notify_count: 0,
        notified_fingerprint: null,
      }),
    ]
    hasOperatorParticipatedInConversation.mockResolvedValue(true) // evidence AT/AFTER the transition
    const decision = await decideOperatorNotification({
      ...autumnInput,
      fingerprintParts: ['confirmed', '2026-08-27T10:00:00Z', null, null, '2026-09-05', '09:00:00', 2],
    })
    expect(decision.outcome).toBe('SUPPRESS_OPERATOR_AWARE')
    expect(ATTENTION_UPDATES.find((u) => u.operator_aware_fingerprint)?.operator_aware_fingerprint).toBe(FP_CONFIRMED_PAID)
  })

  it('4 — operator handles the pending state, then booking TIME changes later => earlier pending-state participation does not cover the new time', async () => {
    ATTENTION = [
      attentionRow({
        subject_type: 'booking',
        subject_id: 'booking-autumn',
        conversation_id: 'conv-autumn',
        state_fingerprint: FP_AUTUMN,
        first_state_fingerprint: FP_AUTUMN,
        notify_count: 0,
        notified_fingerprint: null,
      }),
    ]
    hasOperatorParticipatedInConversation.mockResolvedValue(false) // nothing fresh since the time changed
    const decision = await decideOperatorNotification({
      ...autumnInput,
      fingerprintParts: ['pending', null, null, null, '2026-09-05', '11:00:00', 2], // time moved 09:00 -> 11:00, still pending
    })
    expect(decision.outcome).toBe('SEND_NEW')
    expect(hasOperatorParticipatedInConversation).toHaveBeenCalledWith('conv-autumn', expect.any(String), 'post-transition')
    void FP_NEW_TIME // documents the fingerprint this scenario actually produces
  })

  it('5 — never applies to critical priority, however strong the participation evidence', async () => {
    ATTENTION = []
    hasOperatorParticipatedInConversation.mockResolvedValue(true)
    const decision = await decideOperatorNotification({ ...autumnInput, priority: 'critical' })
    expect(decision.outcome).toBe('SEND_CRITICAL_ESCALATION')
    expect(hasOperatorParticipatedInConversation).not.toHaveBeenCalled()
  })

  it('falls through to a real send when no participation evidence is found', async () => {
    ATTENTION = []
    hasOperatorParticipatedInConversation.mockResolvedValue(false)
    const decision = await decideOperatorNotification(autumnInput)
    expect(decision.outcome).toBe('SEND_NEW')
  })

  it('is opt-in — a caller that never passes operatorParticipationCheck keeps sending exactly as before', async () => {
    ATTENTION = []
    hasOperatorParticipatedInConversation.mockResolvedValue(true)
    const { operatorParticipationCheck: _drop, ...withoutCheck } = autumnInput
    const decision = await decideOperatorNotification(withoutCheck)
    expect(decision.outcome).toBe('SEND_NEW')
    expect(hasOperatorParticipatedInConversation).not.toHaveBeenCalled()
  })

  it("anchors the check to the ledger's own last_changed_at, not a caller-supplied timestamp — the mode, not the anchor, is what changed", async () => {
    const seededLastChanged = '2026-08-20T00:00:00Z'
    ATTENTION = [
      attentionRow({
        subject_type: 'booking',
        subject_id: 'booking-autumn',
        conversation_id: 'conv-autumn',
        state_fingerprint: FP_AUTUMN,
        first_state_fingerprint: FP_AUTUMN,
        notify_count: 0,
        notified_fingerprint: null,
        last_changed_at: seededLastChanged,
      }),
    ]
    hasOperatorParticipatedInConversation.mockResolvedValue(false)
    await decideOperatorNotification(autumnInput)
    expect(hasOperatorParticipatedInConversation).toHaveBeenCalledWith('conv-autumn', seededLastChanged, 'initial')
  })
})
