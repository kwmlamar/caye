import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * maybeEscalateToFounder is the deterministic (non-agentic) founder
 * backstop — the one Caye-initiated-thread call site that isn't reached
 * through cayeAgent's tool loop (unlike opportunity-scan, which gets
 * relate_to_direct_thread for free via the registry). This test covers
 * Test G at that specific call site: a Direct thread gets created
 * alongside the existing WhatsApp ping, and a failure creating it must
 * never swallow the ping that already went out.
 */

const { enqueueEscalationPings, createCayeInitiatedThreadMessage, UPDATED } = vi.hoisted(() => ({
  enqueueEscalationPings: vi.fn(() => Promise.resolve()),
  createCayeInitiatedThreadMessage: vi.fn(
    (
      _supabase: unknown,
      _args: { workspaceId: string; subjectType: string; subjectId: string; titleHint: string; message: string }
    ) => Promise.resolve({ thread: { id: 'thread-1' }, reused: false })
  ),
  UPDATED: [] as Record<string, unknown>[],
}))

vi.mock('./triggers', () => ({
  enqueueEscalationPings,
  resolveEscalationRecipients: vi.fn(),
}))
vi.mock('./escalation', () => ({ labelForCategory: (c: string) => c }))
vi.mock('./urgency', () => ({ classifyHoldUrgency: () => 'normal', extractTargetDate: () => null }))
vi.mock('@/lib/operator-identity', () => ({ resolveOperatorByPhone: vi.fn() }))
vi.mock('./escalation-expiry', () => ({ BOOKING_LOOKUP_FAILED: '__lookup_failed__', shouldExpireOnTargetDate: vi.fn() }))
vi.mock('./contact-display', () => ({ displayContactName: (n: string) => n }))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, _val: unknown) => {
          UPDATED.push(patch)
          return Promise.resolve({ data: null, error: null })
        },
      }),
    }),
  }),
}))

vi.mock('@/lib/caye-direct-threads', () => ({ createCayeInitiatedThreadMessage }))

import { maybeEscalateToFounder, type EscalationRow, FOUNDER_ESCALATION_HOURS } from './escalation-followup'

function agedRow(overrides: Partial<EscalationRow> = {}): EscalationRow {
  const createdAt = new Date(Date.now() - (FOUNDER_ESCALATION_HOURS + 1) * 60 * 60 * 1000).toISOString()
  return {
    id: 'esc-1',
    workspace_id: 'ws-1',
    conversation_id: 'conv-1',
    category: 'policy',
    route_to: 'owner',
    customer_facing_message: 'Waiting on a reply.',
    internal_context: 'Customer asking about deposit.',
    ping_summary: null,
    owner_responded_at: null,
    founder_escalated_at: null,
    created_at: createdAt,
    ...overrides,
  } as EscalationRow
}

beforeEach(() => {
  UPDATED.length = 0
  enqueueEscalationPings.mockClear()
  createCayeInitiatedThreadMessage.mockClear()
  createCayeInitiatedThreadMessage.mockResolvedValue({ thread: { id: 'thread-1' }, reused: false })
})

describe('maybeEscalateToFounder — Direct thread creation (Test G)', () => {
  it('creates a Direct thread keyed to the escalation alongside the WhatsApp ping', async () => {
    const row = agedRow()
    const fired = await maybeEscalateToFounder(row, 'Jeff', 'still waiting on the operator')

    expect(fired).toBe(true)
    expect(enqueueEscalationPings).toHaveBeenCalledTimes(1)
    expect(createCayeInitiatedThreadMessage).toHaveBeenCalledTimes(1)
    const call = createCayeInitiatedThreadMessage.mock.calls[0][1]
    expect(call.subjectType).toBe('escalation')
    expect(call.subjectId).toBe('esc-1')
    expect(call.workspaceId).toBe('ws-1')
  })

  it('still reports success and does not throw if Direct thread creation fails (best-effort)', async () => {
    createCayeInitiatedThreadMessage.mockRejectedValueOnce(new Error('db down'))
    const row = agedRow()

    const fired = await maybeEscalateToFounder(row, 'Jeff', 'still waiting')

    // The ping already went out — a thread-creation failure must not undo it.
    expect(fired).toBe(true)
    expect(enqueueEscalationPings).toHaveBeenCalledTimes(1)
    expect(UPDATED[0]).toMatchObject({ founder_escalated_at: expect.any(String) })
  })

  it('does not fire at all for an escalation already routed to the founder', async () => {
    const row = agedRow({ route_to: 'founder' })
    const fired = await maybeEscalateToFounder(row, 'Jeff', 'still waiting')
    expect(fired).toBe(false)
    expect(createCayeInitiatedThreadMessage).not.toHaveBeenCalled()
  })
})
