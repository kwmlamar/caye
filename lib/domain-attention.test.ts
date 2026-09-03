import { describe, expect, it } from 'vitest'

import {
  SUBJECT_CONSTRUCTION_CHANGE,
  fingerprintPartsFor,
  labelFor,
  projectDomainEventsToAttention,
  ruleFor,
  titleFor,
  type DomainAttentionEvent,
} from './domain-attention'

const WORKSPACE = '11111111-1111-1111-1111-111111111111'

function event(overrides: Partial<DomainAttentionEvent> = {}): DomainAttentionEvent {
  return {
    workspaceId: WORKSPACE,
    type: 'domain.purchase_order.status_changed',
    subjectId: 'bedrock:purchase_order:po-77',
    isFailure: false,
    occurredAt: '2026-09-02T14:00:00.000Z',
    payload: {
      change_kind: 'transition',
      observed_at: '2026-09-02T14:05:00.000Z',
      source: { system: 'bedrock', entity_type: 'purchase_order', entity_id: 'po-77' },
      changes: [{ field: 'status', previous: 'ordered', current: 'received' }],
      snapshot: { po_number: 'PO-1042' },
    },
    ...overrides,
  }
}

/** Records what the ledger was asked to observe, without touching Supabase. */
function recorder() {
  const calls: Array<Record<string, unknown>> = []
  const observe = (async (args: Record<string, unknown>) => {
    calls.push(args)
    return null
  }) as never
  return { calls, observe }
}

/**
 * Runs the projection with no real Supabase access: `loadEvents` returns the
 * fixture events directly, and `loadConfig` returns `config` — defaulting to
 * `null` (no workspace policy on record) so a test that does not care about
 * policy does not need to say so.
 */
function run(
  events: DomainAttentionEvent[],
  observe: never,
  config: Record<string, unknown> | null = null
) {
  return projectDomainEventsToAttention({
    workspaceId: WORKSPACE,
    deps: { loadEvents: async () => events, loadConfig: async () => config, observe },
  })
}

describe('projectDomainEventsToAttention', () => {
  it('raises one attention item per accepted change, keyed on the source record', async () => {
    const { calls, observe } = recorder()
    const result = await run([event()], observe)

    expect(result).toEqual({ considered: 1, raised: 1, skipped: { bootstrap: 0, unresolvable: 0, muted: 0 } })
    expect(calls).toHaveLength(1)
    expect(calls[0].subjectType).toBe(SUBJECT_CONSTRUCTION_CHANGE)
    expect(calls[0].subjectId).toBe('bedrock:purchase_order:po-77')
    expect(calls[0].workspaceId).toBe(WORKSPACE)
  })

  it('does not announce first sight of pre-existing records', async () => {
    // Connecting a ledger with sixteen months of history must not deliver
    // sixteen months of "news" on day one.
    const { calls, observe } = recorder()
    const result = await run(
      [event({ payload: { ...event().payload, change_kind: 'bootstrap' } })],
      observe
    )

    expect(result.raised).toBe(0)
    expect(result.skipped.bootstrap).toBe(1)
    expect(calls).toHaveLength(0)
  })

  it('skips an event with no subject id rather than inventing a key', async () => {
    // A synthesised key would split one record's history into separate ledger
    // rows, which is the duplicate-record failure the ledger cannot recover from.
    const { calls, observe } = recorder()
    const result = await run([event({ subjectId: null })], observe)

    expect(result.raised).toBe(0)
    expect(result.skipped.unresolvable).toBe(1)
    expect(calls).toHaveLength(0)
  })

  it('carries the policy priority and next action through to the ledger', async () => {
    const { calls, observe } = recorder()
    await run([event({ type: 'domain.estimate.status_changed' })], observe)

    expect(calls[0].priority).toBe('decision')
    expect(String(calls[0].nextAction)).toContain('contract')
  })

  it('never marks a source-system change as blocked on the operator', async () => {
    // Nothing is waiting on the owner to unblock a change the ledger already
    // made, and Caye cannot close it out by acting alone either.
    const { calls, observe } = recorder()
    await run([event()], observe)

    expect(calls[0].blockedOnOperator).toBe(false)
    expect(calls[0].resolvableAutonomously).toBe(false)
  })

  it('processes a mixed batch without letting one skip stop the rest', async () => {
    const { calls, observe } = recorder()
    const result = await run(
      [
        event({ payload: { ...event().payload, change_kind: 'bootstrap' } }),
        event({ subjectId: 'bedrock:estimate:est-3', type: 'domain.estimate.status_changed' }),
        event({ subjectId: null }),
      ],
      observe
    )

    expect(result).toEqual({
      considered: 3,
      raised: 1,
      skipped: { bootstrap: 1, unresolvable: 1, muted: 0 },
    })
    expect(calls).toHaveLength(1)
  })

  it('skips a muted event and counts it, without ever calling observe', async () => {
    const { calls, observe } = recorder()
    const config = { policy: { attention: { muted: ['purchase_order.status_changed'] } } }
    const result = await run([event()], observe, config)

    expect(result).toEqual({ considered: 1, raised: 0, skipped: { bootstrap: 0, unresolvable: 0, muted: 1 } })
    expect(calls).toHaveLength(0)
  })

  it('still raises a failed change as critical even when its rule key is muted and overridden', async () => {
    // A workspace muting or downgrading routine noise must not accidentally
    // silence the one signal that means "this broke."
    const { calls, observe } = recorder()
    const config = {
      policy: {
        attention: {
          muted: ['purchase_order.status_changed'],
          'purchase_order.status_changed': { priority: 'routine' },
        },
      },
    }
    const result = await run([event({ isFailure: true })], observe, config)

    expect(result).toEqual({ considered: 1, raised: 1, skipped: { bootstrap: 0, unresolvable: 0, muted: 0 } })
    expect(calls).toHaveLength(1)
    expect(calls[0].priority).toBe('critical')
  })

  it('applies a workspace override to change the raised priority', async () => {
    const { calls, observe } = recorder()
    const config = {
      policy: { attention: { 'purchase_order.status_changed': { priority: 'routine' } } },
    }
    await run([event()], observe, config)

    expect(calls[0].priority).toBe('routine')
  })
})

describe('ruleFor', () => {
  it('treats a failed change as critical whatever the entity was', () => {
    expect(ruleFor('domain.receipt.processed', true)?.priority).toBe('critical')
  })

  it('falls back to awareness for an entity type the policy has no opinion about', () => {
    // A new entity type must not silently arrive as urgent, and must not be
    // silently dropped either.
    expect(ruleFor('domain.shipment.status_changed', false)?.priority).toBe('awareness')
  })

  it('treats a contract value move as a decision, not mere awareness', () => {
    const rule = ruleFor('domain.project.value_changed', false)
    // Not muted by default: null here would mean the owner never hears that a
    // contract figure moved, which is the exact gap this rule was added to close.
    expect(rule).not.toBeNull()
    expect(rule?.priority).toBe('decision')
    expect(String(rule?.nextAction)).toContain('paperwork')
  })

  it('keeps routine ledger bookkeeping out of the decision tier', () => {
    expect(ruleFor('domain.pay_period.paid', false)?.priority).toBe('routine')
  })

  it('returns the shipped rule when there is no workspace config', () => {
    expect(ruleFor('domain.purchase_order.status_changed', false, null)).toEqual({
      priority: 'awareness',
      nextAction: 'If material has landed, confirm what is on island and release anything waiting on it.',
    })
  })

  it('returns null for a muted rule, never a downgraded priority', () => {
    const config = { policy: { attention: { muted: ['purchase_order.status_changed'] } } }
    expect(ruleFor('domain.purchase_order.status_changed', false, config)).toBeNull()
  })

  it('a failure is always critical even when the rule key is muted', () => {
    const config = { policy: { attention: { muted: ['purchase_order.status_changed'] } } }
    expect(ruleFor('domain.purchase_order.status_changed', true, config)?.priority).toBe('critical')
  })

  it('a failure is always critical even when the rule key has an override', () => {
    const config = {
      policy: { attention: { 'purchase_order.status_changed': { priority: 'routine' } } },
    }
    expect(ruleFor('domain.purchase_order.status_changed', true, config)).toEqual({
      priority: 'critical',
      nextAction: 'A change could not be processed. Check the source record.',
    })
  })

  it('applies a workspace override on top of the shipped rule', () => {
    const config = {
      policy: { attention: { 'estimate.status_changed': { priority: 'awareness' } } },
    }
    const rule = ruleFor('domain.estimate.status_changed', false, config)

    // priority is overridden; next_action falls through from the shipped rule
    // because the override did not say anything about it.
    expect(rule?.priority).toBe('awareness')
    expect(rule?.nextAction).toContain('contract')
  })

  it('an explicit next_action: null clears the shipped next action', () => {
    const config = {
      policy: { attention: { 'estimate.status_changed': { next_action: null } } },
    }
    expect(ruleFor('domain.estimate.status_changed', false, config)).toEqual({
      priority: 'decision',
      nextAction: null,
    })
  })

  it('ignores an override priority outside the AttentionPriority union', () => {
    const config = {
      policy: { attention: { 'purchase_order.status_changed': { priority: 'urgent' } } },
    }
    const rule = ruleFor('domain.purchase_order.status_changed', false, config)

    // Falls back to the shipped priority rather than passing 'urgent' to the ledger.
    expect(rule?.priority).toBe('awareness')
  })
})

describe('fingerprintPartsFor', () => {
  it('is stable when the same change is re-observed later', () => {
    // Re-observation is not news. Including observed_at or an event id here
    // would re-earn attention on every overlapping sync window.
    const first = fingerprintPartsFor(event())
    const second = fingerprintPartsFor(
      event({
        occurredAt: '2026-09-02T18:00:00.000Z',
        payload: { ...event().payload, observed_at: '2026-09-02T18:30:00.000Z' },
      })
    )

    expect(second).toEqual(first)
  })

  it('changes when the record actually moves again', () => {
    const before = fingerprintPartsFor(event())
    const after = fingerprintPartsFor(
      event({
        payload: {
          ...event().payload,
          changes: [{ field: 'status', previous: 'received', current: 'cancelled' }],
        },
      })
    )

    expect(after).not.toEqual(before)
  })
})

describe('titleFor', () => {
  it('names the record the way the source system names it', () => {
    expect(titleFor(event())).toBe('Purchase order PO-1042: status ordered → received')
  })

  it('does not leak an internal identifier when the snapshot has no label', () => {
    // attention-presentation strips internal identifiers before display, so a
    // title built from an id arrives at the operator empty.
    const title = titleFor(
      event({
        payload: {
          ...event().payload,
          snapshot: { id: '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f' },
        },
      })
    )

    expect(title).not.toContain('9f1c2d3e')
    expect(title).toBe('Purchase order: status ordered → received')
  })

  it('reads a missing previous value as none rather than undefined', () => {
    const title = titleFor(
      event({
        payload: {
          ...event().payload,
          changes: [{ field: 'expected_delivery_date', previous: null, current: '2026-09-30' }],
        },
      })
    )

    expect(title).toContain('expected delivery date none → 2026-09-30')
  })
})

describe('labelFor', () => {
  it('prefers a human reference over the entity type', () => {
    expect(labelFor(event().payload)).toBe('PO-1042')
  })

  it('ignores a blank label', () => {
    expect(labelFor({ ...event().payload, snapshot: { po_number: '   ' } })).toBe('purchase order')
  })
})
