import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => { throw new Error('no db in tests') } }))

import { deliverAttentionItem, deliverAttentionItems, type DeliverableAttentionItem } from './attention-delivery'
import type { RoutableOperator } from './attention-routing'

const WORKSPACE = '5a21a758-ed47-4de7-bd93-6ddd8578d739'

// The real ODS roster shape, including the two traps it carries: operator 31's
// WhatsApp display name reads "Wallace Sineus." but the ledger profile is
// LAMAR, and operator 35 (Omar) has never replied to the verification
// template. Both are load-bearing in the assertions below.
const LAMAR: RoutableOperator = { id: 31, name: 'Lamar', phone: '+12425550031', role: 'staff', verified: true }
const WALLACE: RoutableOperator = { id: 32, name: 'Wallace Sr.', phone: '+12425550032', role: 'owner', verified: true }
const OMAR: RoutableOperator = { id: 35, name: 'Omar', phone: '+12425550035', role: 'staff', verified: false }

const ROSTER = [LAMAR, WALLACE, OMAR]
const ROLES = { operator_roles: { owner: 32, office: 31, hr: 34, estimator: 35 } }

function receivable(over: Partial<DeliverableAttentionItem> = {}): DeliverableAttentionItem {
  return {
    subjectType: 'receivable',
    subjectId: 'inv-off-the-reef',
    title: 'Off the Reef: $17,575.75 outstanding, 63 days, no payment ever recorded',
    nextAction: 'No payment is on record for this one. Check the bank and tell me either way.',
    priority: 'awareness',
    ...over,
  }
}

function harness(over: { enqueueReturns?: { id: string } | null } = {}) {
  const enqueued: Record<string, unknown>[] = []
  const notified: Record<string, unknown>[] = []
  const enqueue = (async (input: Record<string, unknown>) => {
    enqueued.push(input)
    return over.enqueueReturns === undefined ? { id: 'queue-row-1' } : over.enqueueReturns
  }) as never
  const markNotified = (async (args: Record<string, unknown>) => { notified.push(args) }) as never
  return { enqueued, notified, deps: { enqueue, markNotified, now: () => new Date('2026-09-04T14:00:00Z') } }
}

describe('construction attention delivery — routing', () => {
  it('sends a routine receivable to the office, not the owner', async () => {
    const h = harness()
    const outcome = await deliverAttentionItem({
      workspaceId: WORKSPACE, item: receivable(), roster: ROSTER, roleConfig: ROLES, deps: h.deps,
    })

    expect(outcome.delivered).toBe(true)
    expect(outcome).toMatchObject({ operatorId: 31 })
    expect(h.enqueued).toHaveLength(1)
    expect(h.enqueued[0]).toMatchObject({
      workspaceId: WORKSPACE,
      kind: 'construction_attention',
    })
    expect((h.enqueued[0].payload as Record<string, unknown>).to_phone).toBe(LAMAR.phone)
  })

  it('escalates a critical receivable to the owner, because money at risk is his call', async () => {
    const h = harness()
    const outcome = await deliverAttentionItem({
      workspaceId: WORKSPACE, item: receivable({ priority: 'critical' }), roster: ROSTER, roleConfig: ROLES, deps: h.deps,
    })

    expect(outcome).toMatchObject({ delivered: true, operatorId: 32 })
    expect((h.enqueued[0].payload as Record<string, unknown>).to_phone).toBe(WALLACE.phone)
  })

  it('refuses to deliver to an unverified operator rather than falling back to someone else', async () => {
    const h = harness()
    const outcome = await deliverAttentionItem({
      workspaceId: WORKSPACE,
      item: receivable({ subjectType: 'construction_change', entityType: 'estimate' }),
      roster: ROSTER,
      roleConfig: ROLES,
      deps: h.deps,
    })

    expect(outcome.delivered).toBe(false)
    expect(outcome.reason).toMatch(/not verified/i)
    // The point of the assertion: nobody else got it either.
    expect(h.enqueued).toHaveLength(0)
  })

  it('reports an unmapped role instead of defaulting to the owner', async () => {
    const h = harness()
    const outcome = await deliverAttentionItem({
      workspaceId: WORKSPACE, item: receivable(), roster: ROSTER, roleConfig: { operator_roles: {} }, deps: h.deps,
    })

    expect(outcome.delivered).toBe(false)
    expect(outcome.reason).toMatch(/no operator is mapped to role 'office'/i)
    expect(h.enqueued).toHaveLength(0)
  })
})

describe('construction attention delivery — the send itself', () => {
  it('carries the operator-facing text and keeps the audit trail on the row', async () => {
    const h = harness()
    await deliverAttentionItem({ workspaceId: WORKSPACE, item: receivable(), roster: ROSTER, roleConfig: ROLES, deps: h.deps })

    const payload = h.enqueued[0].payload as Record<string, unknown>
    expect(payload.title).toMatch(/Off the Reef/)
    expect(payload.next_action).toMatch(/tell me either way/)
    // Why this person got it, readable from the queue row alone even if the
    // workspace's role config changes afterwards.
    expect(payload.routing_reason).toMatch(/Lamar/)
    expect(payload.subject_id).toBe('inv-off-the-reef')
  })

  it('marks the ledger notified only after the row actually exists, and carries the queue id', async () => {
    const h = harness()
    await deliverAttentionItem({ workspaceId: WORKSPACE, item: receivable(), roster: ROSTER, roleConfig: ROLES, deps: h.deps })

    expect(h.notified).toHaveLength(1)
    expect(h.notified[0]).toMatchObject({
      workspaceId: WORKSPACE,
      subjectType: 'receivable',
      subjectId: 'inv-off-the-reef',
      queueId: 'queue-row-1',
    })
  })

  it('does NOT mark the ledger notified when the queue declined the row', async () => {
    // This is the notifications_paused case, which is ODS's live state. If
    // this marked the item notified anyway, flipping the flag later would
    // deliver nothing: every outstanding invoice would already look told.
    const h = harness({ enqueueReturns: null })
    const outcome = await deliverAttentionItem({
      workspaceId: WORKSPACE, item: receivable(), roster: ROSTER, roleConfig: ROLES, deps: h.deps,
    })

    expect(outcome.delivered).toBe(false)
    expect(outcome.reason).toMatch(/queue declined/i)
    expect(h.notified).toHaveLength(0)
  })

  it('keys idempotency per subject and operator, bucketed to the hour', async () => {
    const h = harness()
    await deliverAttentionItem({ workspaceId: WORKSPACE, item: receivable(), roster: ROSTER, roleConfig: ROLES, deps: h.deps })

    expect(h.enqueued[0].idempotencyKey).toBe(
      'construction_attention-receivable-inv-off-the-reef-31-2026-09-04T14:00:00.000Z'
    )
  })
})

describe('construction attention delivery — batches', () => {
  it('one unroutable item does not withhold the rest', async () => {
    const h = harness()
    const result = await deliverAttentionItems({
      workspaceId: WORKSPACE,
      items: [
        receivable({ subjectId: 'inv-a' }),
        receivable({ subjectId: 'inv-b', subjectType: 'construction_change', entityType: 'estimate' }),
        receivable({ subjectId: 'inv-c', priority: 'critical' }),
      ],
      deps: { ...h.deps, loadRoster: async () => ROSTER, loadRoleConfig: async () => ROLES },
    })

    expect(result).toMatchObject({ considered: 3, delivered: 2 })
    expect(result.unrouted).toHaveLength(1)
    expect(result.unrouted[0].subjectId).toBe('inv-b')
    expect(h.enqueued).toHaveLength(2)
  })

  it('loads the roster once for the whole batch', async () => {
    const h = harness()
    let rosterLoads = 0
    await deliverAttentionItems({
      workspaceId: WORKSPACE,
      items: [receivable({ subjectId: 'a' }), receivable({ subjectId: 'b' }), receivable({ subjectId: 'c' })],
      deps: {
        ...h.deps,
        loadRoster: async () => { rosterLoads++; return ROSTER },
        loadRoleConfig: async () => ROLES,
      },
    })

    expect(rosterLoads).toBe(1)
  })

  it('does not touch the roster at all when there is nothing to deliver', async () => {
    let rosterLoads = 0
    const result = await deliverAttentionItems({
      workspaceId: WORKSPACE,
      items: [],
      deps: { loadRoster: async () => { rosterLoads++; return ROSTER }, loadRoleConfig: async () => ROLES },
    })

    expect(result).toMatchObject({ considered: 0, delivered: 0 })
    expect(rosterLoads).toBe(0)
  })
})
