import { describe, it, expect } from 'vitest'
import { vi } from 'vitest'

vi.mock('server-only', () => ({}))

type Row = Record<string, unknown>
type Tables = Record<string, Row[]>

/**
 * Minimal fake Postgrest query builder — supports exactly the chain shapes
 * getActivitySince actually issues (select/eq/gte/lte/in/or/order/limit,
 * awaited directly rather than via .single()). Not a general-purpose
 * Supabase mock; extend the clause parsing in `or()` if a future query
 * needs an operator beyond `gte`.
 */
class FakeQuery implements PromiseLike<{ data: Row[]; error: null }> {
  private filters: Array<(r: Row) => boolean> = []
  private orderCol?: string
  private orderAsc = true
  private limitN?: number

  constructor(private rows: Row[]) {}

  select(): this {
    return this
  }
  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val)
    return this
  }
  gte(col: string, val: unknown): this {
    this.filters.push((r) => r[col] != null && (r[col] as string) >= (val as string))
    return this
  }
  in(col: string, vals: unknown[]): this {
    this.filters.push((r) => vals.includes(r[col]))
    return this
  }
  or(expr: string): this {
    const clauses = expr.split(',').map((c) => {
      const [col, op, ...rest] = c.split('.')
      return { col, op, val: rest.join('.') }
    })
    this.filters.push((r) =>
      clauses.some(({ col, op, val }) => {
        if (op === 'gte') return r[col] != null && (r[col] as string) >= val
        return false
      })
    )
    return this
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col
    this.orderAsc = opts?.ascending ?? true
    return this
  }
  limit(n: number): this {
    this.limitN = n
    return this
  }
  then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    let result = this.rows.filter((r) => this.filters.every((f) => f(r)))
    const col = this.orderCol
    if (col) {
      result = [...result].sort((a, b) => {
        const av = a[col] as string | null
        const bv = b[col] as string | null
        if (av === bv) return 0
        if (av == null) return this.orderAsc ? -1 : 1
        if (bv == null) return this.orderAsc ? 1 : -1
        return this.orderAsc ? (av < bv ? -1 : 1) : av > bv ? -1 : 1
      })
    }
    if (this.limitN != null) result = result.slice(0, this.limitN)
    return Promise.resolve({ data: result, error: null }).then(onfulfilled, onrejected)
  }
}

function makeFakeSupabase(tables: Tables) {
  return {
    from(table: string) {
      return new FakeQuery(tables[table] ?? [])
    },
  }
}

const WORKSPACE_ID = 'ws-1'
const CUTOFF = '2026-08-06T00:00:00.000Z'
const BEFORE_CUTOFF = '2026-08-01T00:00:00.000Z'
const AFTER_CUTOFF = '2026-08-06T12:00:00.000Z'

function baseTables(overrides: Partial<Tables> = {}): Tables {
  return {
    connected_accounts: [{ id: 'acct-1', user_id: WORKSPACE_ID }],
    bookings: [],
    unified_conversations: [],
    unified_messages: [],
    caye_escalations: [],
    ...overrides,
  }
}

let currentTables: Tables = baseTables()

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => makeFakeSupabase(currentTables),
}))

// Imported after the mocks above so the module picks up the mocked deps.
const { getActivitySince, isActivityEmpty } = await import('./activity-since')

describe('isActivityEmpty', () => {
  it('is true for an activity object with every list empty', () => {
    expect(
      isActivityEmpty({ cutoff: CUTOFF, holdEvents: [], bookingEvents: [], escalationEvents: [], chaseMessages: [] })
    ).toBe(true)
  })

  it('is false when any single list is non-empty', () => {
    expect(
      isActivityEmpty({
        cutoff: CUTOFF,
        holdEvents: [{ conversationId: 'c1', customer: null, channel: 'email', markedAt: null, stillHeld: true, resolution: null }],
        bookingEvents: [],
        escalationEvents: [],
        chaseMessages: [],
      })
    ).toBe(false)
  })
})

describe('getActivitySince', () => {
  it('returns an empty result when nothing in the workspace has moved since cutoff', async () => {
    currentTables = baseTables({
      unified_conversations: [
        {
          id: 'c-old',
          connected_account_id: 'acct-1',
          customer_name: 'Old Held Thread',
          channel_type: 'email',
          human_agent_enabled: true,
          human_agent_marked_at: BEFORE_CUTOFF,
          is_archived: false,
        },
      ],
      bookings: [
        {
          user_id: WORKSPACE_ID,
          customer_name: 'Old Booking',
          status: 'confirmed',
          booking_date: '2026-07-01',
          created_at: BEFORE_CUTOFF,
          updated_at: BEFORE_CUTOFF,
        },
      ],
    })

    const activity = await getActivitySince(WORKSPACE_ID, CUTOFF)
    expect(isActivityEmpty(activity)).toBe(true)
  })

  it('reports a new still-open hold as a hold event with no resolution', async () => {
    currentTables = baseTables({
      unified_conversations: [
        {
          id: 'c-new',
          connected_account_id: 'acct-1',
          customer_name: 'Robert',
          channel_type: 'email',
          human_agent_enabled: true,
          human_agent_marked_at: AFTER_CUTOFF,
          is_archived: false,
        },
      ],
    })

    const activity = await getActivitySince(WORKSPACE_ID, CUTOFF)
    expect(activity.holdEvents).toEqual([
      { conversationId: 'c-new', customer: 'Robert', channel: 'email', markedAt: AFTER_CUTOFF, stillHeld: true, resolution: null },
    ])
    expect(isActivityEmpty(activity)).toBe(false)
  })

  it('classifies a hold resolved by Caye replying after it was marked', async () => {
    currentTables = baseTables({
      unified_conversations: [
        {
          id: 'c-resolved',
          connected_account_id: 'acct-1',
          customer_name: 'Laney',
          channel_type: 'email',
          human_agent_enabled: false,
          human_agent_marked_at: AFTER_CUTOFF,
          is_archived: false,
        },
      ],
      unified_messages: [
        {
          conversation_id: 'c-resolved',
          sender_type: 'business',
          is_internal: false,
          sent_at: '2026-08-06T13:00:00.000Z',
          metadata: { generated_by: 'caye' },
        },
      ],
    })

    const activity = await getActivitySince(WORKSPACE_ID, CUTOFF)
    expect(activity.holdEvents).toEqual([
      { conversationId: 'c-resolved', customer: 'Laney', channel: 'email', markedAt: AFTER_CUTOFF, stillHeld: false, resolution: 'replied' },
    ])
  })

  it('reports created vs updated bookings distinctly', async () => {
    currentTables = baseTables({
      bookings: [
        {
          user_id: WORKSPACE_ID,
          customer_name: 'New Booking',
          status: 'confirmed',
          booking_date: '2026-08-10',
          created_at: AFTER_CUTOFF,
          updated_at: AFTER_CUTOFF,
        },
        {
          user_id: WORKSPACE_ID,
          customer_name: 'Changed Booking',
          status: 'cancelled',
          booking_date: '2026-08-12',
          created_at: BEFORE_CUTOFF,
          updated_at: AFTER_CUTOFF,
        },
      ],
    })

    const activity = await getActivitySince(WORKSPACE_ID, CUTOFF)
    const byName = Object.fromEntries(activity.bookingEvents.map((b) => [b.customer, b.event]))
    expect(byName['New Booking']).toBe('created')
    expect(byName['Changed Booking']).toBe('updated')
  })

  it('emits one escalation event per timestamp that falls in-window, not one per row', async () => {
    currentTables = baseTables({
      caye_escalations: [
        {
          workspace_id: WORKSPACE_ID,
          conversation_id: 'c1',
          category: 'knowledge',
          route_to: 'owner',
          created_at: BEFORE_CUTOFF,
          owner_responded_at: AFTER_CUTOFF,
          expired_at: null,
        },
        {
          workspace_id: WORKSPACE_ID,
          conversation_id: 'c2',
          category: 'policy',
          route_to: 'owner',
          created_at: AFTER_CUTOFF,
          owner_responded_at: null,
          expired_at: null,
        },
      ],
    })

    const activity = await getActivitySince(WORKSPACE_ID, CUTOFF)
    expect(activity.escalationEvents).toHaveLength(2)
    expect(activity.escalationEvents).toContainEqual({
      conversationId: 'c1',
      category: 'knowledge',
      routeTo: 'owner',
      status: 'resolved',
      at: AFTER_CUTOFF,
    })
    expect(activity.escalationEvents).toContainEqual({
      conversationId: 'c2',
      category: 'policy',
      routeTo: 'owner',
      status: 'opened',
      at: AFTER_CUTOFF,
    })
  })

  it('does NOT report an escalation whose only timestamps are all before cutoff', async () => {
    currentTables = baseTables({
      caye_escalations: [
        {
          workspace_id: WORKSPACE_ID,
          conversation_id: 'c1',
          category: 'knowledge',
          route_to: 'owner',
          created_at: BEFORE_CUTOFF,
          owner_responded_at: BEFORE_CUTOFF,
          expired_at: null,
        },
      ],
    })

    const activity = await getActivitySince(WORKSPACE_ID, CUTOFF)
    expect(activity.escalationEvents).toEqual([])
  })

  it('reports a customer chasing an already-held thread as a chase message', async () => {
    currentTables = baseTables({
      unified_conversations: [
        {
          id: 'c-old-held',
          connected_account_id: 'acct-1',
          customer_name: 'Marissa',
          channel_type: 'email',
          human_agent_enabled: true,
          human_agent_marked_at: BEFORE_CUTOFF, // held long before cutoff — structurally unchanged
          is_archived: false,
        },
      ],
      unified_messages: [
        {
          conversation_id: 'c-old-held',
          sender_type: 'customer',
          is_internal: false,
          sent_at: AFTER_CUTOFF,
        },
      ],
    })

    const activity = await getActivitySince(WORKSPACE_ID, CUTOFF)
    // The hold itself is unchanged (marked before cutoff) so it must not
    // appear as a hold event — only as a chase.
    expect(activity.holdEvents).toEqual([])
    expect(activity.chaseMessages).toEqual([{ conversationId: 'c-old-held', customer: 'Marissa', sentAt: AFTER_CUTOFF }])
    expect(isActivityEmpty(activity)).toBe(false)
  })

  it('does not treat a message on a currently-unheld conversation as a chase', async () => {
    currentTables = baseTables({
      unified_conversations: [
        {
          id: 'c-not-held',
          connected_account_id: 'acct-1',
          customer_name: 'Resolved Customer',
          channel_type: 'email',
          human_agent_enabled: false,
          human_agent_marked_at: BEFORE_CUTOFF,
          is_archived: false,
        },
      ],
      unified_messages: [
        {
          conversation_id: 'c-not-held',
          sender_type: 'customer',
          is_internal: false,
          sent_at: AFTER_CUTOFF,
        },
      ],
    })

    const activity = await getActivitySince(WORKSPACE_ID, CUTOFF)
    expect(activity.chaseMessages).toEqual([])
    expect(isActivityEmpty(activity)).toBe(true)
  })
})
