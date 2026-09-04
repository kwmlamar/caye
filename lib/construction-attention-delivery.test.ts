import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => { throw new Error('no db in tests') } }))

import { deliverConstructionAttention, isUndelivered } from './construction-attention-delivery'
import type { DeliverableAttentionItem } from './attention-delivery'
import type { RoutableOperator } from './attention-routing'

const WORKSPACE = '5a21a758-ed47-4de7-bd93-6ddd8578d739'
const LAMAR: RoutableOperator = { id: 31, name: 'Lamar', phone: '+12425550031', role: 'staff', verified: true }
const ROLES = { operator_roles: { owner: 32, office: 31, hr: 34, estimator: 35 } }

function item(over: Partial<DeliverableAttentionItem> = {}): DeliverableAttentionItem {
  return {
    subjectType: 'receivable',
    subjectId: 'inv-1',
    title: 'Off the Reef: $17,575.75 outstanding, 63 days, no payment ever recorded',
    nextAction: 'Check the bank and tell me either way.',
    priority: 'awareness',
    ...over,
  }
}

function deps(over: Record<string, unknown> = {}) {
  const enqueued: Record<string, unknown>[] = []
  return {
    enqueued,
    deps: {
      loadRoster: async () => [LAMAR],
      loadRoleConfig: async () => ROLES,
      enqueue: (async (input: Record<string, unknown>) => { enqueued.push(input); return { id: 'q1' } }) as never,
      markNotified: (async () => {}) as never,
      isQuietHours: async () => false,
      now: () => new Date('2026-09-04T14:00:00Z'),
      loadUndelivered: async () => [item()],
      ...over,
    },
  }
}

describe('construction attention delivery — gates', () => {
  it('sends nothing during quiet hours, and does not even read the ledger', async () => {
    let ledgerReads = 0
    const h = deps({
      isQuietHours: async () => true,
      loadUndelivered: async () => { ledgerReads++; return [item()] },
    })

    const result = await deliverConstructionAttention({ workspaceId: WORKSPACE, deps: h.deps })

    expect(result).toMatchObject({ skipped: 'quiet_hours', delivered: 0 })
    expect(ledgerReads).toBe(0)
    expect(h.enqueued).toHaveLength(0)
  })

  it('delivers outside quiet hours', async () => {
    const h = deps()
    const result = await deliverConstructionAttention({ workspaceId: WORKSPACE, deps: h.deps })

    expect(result).toMatchObject({ considered: 1, delivered: 1 })
    expect(h.enqueued).toHaveLength(1)
  })

  it('reports rather than throws when nothing is routable', async () => {
    const h = deps({ loadRoleConfig: async () => ({ operator_roles: {} }) })
    const result = await deliverConstructionAttention({ workspaceId: WORKSPACE, deps: h.deps })

    expect(result).toMatchObject({ considered: 1, delivered: 0 })
    expect(h.enqueued).toHaveLength(0)
  })

  it('is a no-op when the ledger has nothing undelivered', async () => {
    const h = deps({ loadUndelivered: async () => [] })
    const result = await deliverConstructionAttention({ workspaceId: WORKSPACE, deps: h.deps })

    expect(result).toMatchObject({ considered: 0, delivered: 0 })
    expect(h.enqueued).toHaveLength(0)
  })
})

describe('is this item news', () => {
  const news = (stateFingerprint: string | null, notifiedFingerprint: string | null) =>
    isUndelivered({ stateFingerprint, notifiedFingerprint })

  it('is news when nobody has ever been told', () => {
    expect(news('abc', null)).toBe(true)
  })

  it('is NOT news when the state has not moved since they were told', () => {
    // The invoice ageing another day must not re-earn a message: age is
    // deliberately excluded from the fingerprint upstream. This is what
    // stops a daily nag turning into a channel nobody reads.
    expect(news('abc', 'abc')).toBe(false)
  })

  it('is news again once the balance or payment state actually changes', () => {
    expect(news('def', 'abc')).toBe(true)
  })

  it('treats a missing state fingerprint as news rather than assuming unchanged', () => {
    expect(news(null, 'abc')).toBe(true)
  })
})
