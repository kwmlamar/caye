import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { isQueueHold, isAttentionHold, holdKindOf, QUEUE_HOLD_KINDS, getAttentionHolds, getAttentionHoldCount } =
  await import('./hold-kinds')

describe('isQueueHold', () => {
  it('recognises both batchable outreach kinds', () => {
    expect(isQueueHold('outreach_first_touch')).toBe(true)
    expect(isQueueHold('outreach_followup')).toBe(true)
  })

  it('does not treat an ordinary hold as a queue item', () => {
    expect(isQueueHold(null)).toBe(false)
    expect(isQueueHold(undefined)).toBe(false)
    expect(isQueueHold('escalation')).toBe(false)
    expect(isQueueHold('')).toBe(false)
  })

  it('ignores non-string values', () => {
    expect(isQueueHold(42)).toBe(false)
    expect(isQueueHold({ hold_kind: 'outreach_followup' })).toBe(false)
  })
})

describe('isAttentionHold', () => {
  // The two real Bimini holds (a complaint from 2026-07-24 and a policy
  // call from 07-25) carry no hold_kind at all.
  it('counts a hold with no kind as needing attention', () => {
    expect(isAttentionHold(null)).toBe(true)
  })

  it('excludes drafted outreach awaiting batch approval', () => {
    expect(isAttentionHold('outreach_followup')).toBe(false)
    expect(isAttentionHold('outreach_first_touch')).toBe(false)
  })

  // Deliberately conservative: a hold path that forgets to set hold_kind
  // must surface to the operator, not vanish into a queue nobody checks.
  it('defaults an unrecognised kind to needing attention', () => {
    expect(isAttentionHold('some_future_kind')).toBe(true)
  })
})

describe('holdKindOf', () => {
  it('reads hold_kind out of a metadata blob', () => {
    expect(holdKindOf({ hold_kind: 'outreach_followup' })).toBe('outreach_followup')
  })

  it('returns null for missing or malformed metadata', () => {
    expect(holdKindOf(null)).toBeNull()
    expect(holdKindOf(undefined)).toBeNull()
    expect(holdKindOf({})).toBeNull()
    expect(holdKindOf('not an object')).toBeNull()
    expect(holdKindOf({ hold_kind: 7 })).toBeNull()
  })

  it('composes with the predicates the readers actually use', () => {
    const outreachThread = { hold_kind: 'outreach_followup', proposed_reply: 'Hey,' }
    const complaintThread = { escalated: true }
    expect(isAttentionHold(holdKindOf(outreachThread))).toBe(false)
    expect(isAttentionHold(holdKindOf(complaintThread))).toBe(true)
  })
})

describe('QUEUE_HOLD_KINDS', () => {
  // send_outreach_batch gates on this exact set. If the read layer and the
  // send gate disagree, a thread can be hidden from the operator but still
  // batch-sendable, or shown but unsendable.
  it('is exactly the two batchable outreach kinds', () => {
    expect([...QUEUE_HOLD_KINDS].sort()).toEqual(['outreach_first_touch', 'outreach_followup'])
  })
})

// Minimal fake Postgrest builder, scoped to exactly the chain
// getAttentionHolds issues: select/eq/in/order/limit on two tables
// (connected_accounts, then unified_conversations), resolved directly
// rather than via .single(). Not a general-purpose mock.
type Row = Record<string, unknown>

function fakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? []
      const filters: Array<(r: Row) => boolean> = []
      let orderCol: string | undefined
      let orderAsc = true
      let nullsFirst = true
      let limitN: number | undefined

      const builder = {
        select: () => builder,
        eq(col: string, val: unknown) {
          filters.push((r) => r[col] === val)
          return builder
        },
        in(col: string, vals: unknown[]) {
          filters.push((r) => vals.includes(r[col]))
          return builder
        },
        order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
          orderCol = col
          orderAsc = opts?.ascending ?? true
          nullsFirst = opts?.nullsFirst ?? true
          return builder
        },
        limit(n: number) {
          limitN = n
          return builder
        },
        then<T>(resolve: (v: { data: Row[]; error: null }) => T) {
          let result = rows.filter((r) => filters.every((f) => f(r)))
          if (orderCol) {
            const col = orderCol
            result = [...result].sort((a, b) => {
              const av = a[col] as string | null
              const bv = b[col] as string | null
              if (av === bv) return 0
              if (av == null) return nullsFirst ? -1 : 1
              if (bv == null) return nullsFirst ? 1 : -1
              return orderAsc ? (av < bv ? -1 : 1) : av > bv ? -1 : 1
            })
          }
          if (limitN != null) result = result.slice(0, limitN)
          return Promise.resolve(resolve({ data: result, error: null }))
        },
      }
      return builder
    },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asClient = (s: unknown) => s as any

describe('getAttentionHolds', () => {
  const WORKSPACE_ID = 'ws-1'
  const account = { id: 'acct-1', user_id: WORKSPACE_ID }

  it('excludes queue holds and orders oldest-held-first', async () => {
    const supabase = fakeSupabase({
      connected_accounts: [account],
      unified_conversations: [
        {
          id: 'conv-real-old',
          connected_account_id: 'acct-1',
          is_archived: false,
          human_agent_enabled: true,
          human_agent_marked_at: '2026-07-24T00:00:00Z',
          customer_name: 'Jeff A Montenaro',
          customer_id: null,
          channel_type: 'email',
          human_agent_reason: 'complaint',
          last_message_preview: null,
          last_message_at: null,
          last_sender_type: null,
          last_business_sender_kind: null,
          target_date: null,
          metadata: null,
        },
        {
          id: 'conv-queue',
          connected_account_id: 'acct-1',
          is_archived: false,
          human_agent_enabled: true,
          human_agent_marked_at: '2026-07-20T00:00:00Z', // older, but must not win
          customer_name: 'Cold Lead Co',
          customer_id: null,
          channel_type: 'email',
          human_agent_reason: null,
          last_message_preview: null,
          last_message_at: null,
          last_sender_type: null,
          last_business_sender_kind: null,
          target_date: null,
          metadata: { hold_kind: 'outreach_followup' },
        },
        {
          id: 'conv-real-newer',
          connected_account_id: 'acct-1',
          is_archived: false,
          human_agent_enabled: true,
          human_agent_marked_at: '2026-07-25T00:00:00Z',
          customer_name: 'Sue Guilbert',
          customer_id: null,
          channel_type: 'email',
          human_agent_reason: 'policy',
          last_message_preview: null,
          last_message_at: null,
          last_sender_type: null,
          last_business_sender_kind: null,
          target_date: null,
          metadata: null,
        },
        {
          id: 'conv-not-held',
          connected_account_id: 'acct-1',
          is_archived: false,
          human_agent_enabled: false,
          human_agent_marked_at: '2026-01-01T00:00:00Z',
          customer_name: 'Long Resolved',
          customer_id: null,
          channel_type: 'email',
          human_agent_reason: null,
          last_message_preview: null,
          last_message_at: null,
          last_sender_type: null,
          last_business_sender_kind: null,
          target_date: null,
          metadata: null,
        },
      ],
    })

    const holds = await getAttentionHolds(asClient(supabase), WORKSPACE_ID)

    expect(holds.map((h) => h.id)).toEqual(['conv-real-old', 'conv-real-newer'])
    expect(holds.every((h) => !('metadata' in h))).toBe(true)
  })

  it('returns nothing for a workspace with no connected accounts', async () => {
    const supabase = fakeSupabase({ connected_accounts: [], unified_conversations: [] })
    expect(await getAttentionHolds(asClient(supabase), WORKSPACE_ID)).toEqual([])
  })
})

describe('getAttentionHoldCount', () => {
  it('matches the length of getAttentionHolds', async () => {
    const supabase = fakeSupabase({
      connected_accounts: [{ id: 'acct-1', user_id: 'ws-1' }],
      unified_conversations: [
        {
          id: 'a',
          connected_account_id: 'acct-1',
          is_archived: false,
          human_agent_enabled: true,
          human_agent_marked_at: '2026-07-24T00:00:00Z',
          metadata: null,
        },
        {
          id: 'b',
          connected_account_id: 'acct-1',
          is_archived: false,
          human_agent_enabled: true,
          human_agent_marked_at: '2026-07-24T00:00:00Z',
          metadata: { hold_kind: 'outreach_first_touch' },
        },
      ],
    })
    expect(await getAttentionHoldCount(asClient(supabase), 'ws-1')).toBe(1)
  })
})
