import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

interface LeadRow {
  id: string
  demo_token: string
  demo_confirmed_at: string | null
  demo_confirmed_phone: string | null
}

let rows: LeadRow[]
let updateCalls: Array<{ id: string; patch: Record<string, unknown> }>

// Minimal fake supporting exactly the query shapes
// confirmOutreachDemoClick issues: select().eq().maybeSingle(), and
// update().eq().is().
function makeFakeSupabase() {
  return {
    from(_table: string) {
      const builder: Record<string, unknown> = {
        select() {
          return builder
        },
        eq(col: keyof LeadRow, val: unknown) {
          ;(builder as { _filtered: LeadRow[] })._filtered = rows.filter((r) => r[col] === val)
          return builder
        },
        maybeSingle() {
          const filtered = (builder as { _filtered?: LeadRow[] })._filtered ?? rows
          return Promise.resolve({ data: filtered[0] ?? null, error: null })
        },
        update(patch: Record<string, unknown>) {
          const updateBuilder = {
            _id: undefined as string | undefined,
            eq(col: string, val: unknown) {
              if (col === 'id') updateBuilder._id = val as string
              return updateBuilder
            },
            is(_col: string, _val: null) {
              if (updateBuilder._id) {
                const row = rows.find((r) => r.id === updateBuilder._id)
                if (row && row.demo_confirmed_at === null) {
                  updateCalls.push({ id: updateBuilder._id, patch })
                  Object.assign(row, patch)
                }
              }
              return Promise.resolve({ error: null })
            },
          }
          return updateBuilder
        },
      }
      return builder
    },
  }
}

let fakeSupabase: ReturnType<typeof makeFakeSupabase>

vi.mock('./supabase-server', () => ({
  createServiceClient: () => fakeSupabase,
}))

const { buildDemoConfirmationRef, parseDemoConfirmationRef, confirmOutreachDemoClick } = await import(
  './outreach-click-demo-confirmation'
)

describe('buildDemoConfirmationRef / parseDemoConfirmationRef', () => {
  it('round-trips a demo token through the ref format', () => {
    const ref = buildDemoConfirmationRef('a1b2c3d4e5f6')
    expect(ref).toBe('[ref:a1b2c3d4e5f6]')
    expect(parseDemoConfirmationRef(ref)).toBe('a1b2c3d4e5f6')
  })

  it('finds the ref embedded inside free-form message text', () => {
    const text = "Hi Caye! I'd like to try it. [ref:a1b2c3d4e5f6]"
    expect(parseDemoConfirmationRef(text)).toBe('a1b2c3d4e5f6')
  })

  it('finds the ref even if the prospect edited the surrounding text', () => {
    const text = 'hey there, saw your email, ref:a1b2c3d4e5f6 is what it said to send but hi! [ref:a1b2c3d4e5f6]'
    expect(parseDemoConfirmationRef(text)).toBe('a1b2c3d4e5f6')
  })

  it('returns null when no ref is present', () => {
    expect(parseDemoConfirmationRef('hi I want to try Caye')).toBeNull()
  })

  it('returns null for a malformed/non-hex ref payload', () => {
    expect(parseDemoConfirmationRef('[ref:not hex!]')).toBeNull()
  })

  it('returns null for an empty ref', () => {
    expect(parseDemoConfirmationRef('[ref:]')).toBeNull()
  })
})

describe('confirmOutreachDemoClick', () => {
  beforeEach(() => {
    rows = [
      { id: 'lead-1', demo_token: 'a1b2c3d4e5f6', demo_confirmed_at: null, demo_confirmed_phone: null },
      { id: 'lead-2', demo_token: 'deadbeefcafe', demo_confirmed_at: '2026-09-01T00:00:00Z', demo_confirmed_phone: '+12345550100' },
    ]
    updateCalls = []
    fakeSupabase = makeFakeSupabase()
  })

  it('confirms an unconfirmed lead matched by demo_token', async () => {
    const result = await confirmOutreachDemoClick(fakeSupabase as never, {
      demoToken: 'a1b2c3d4e5f6',
      phone: '+12345550199',
      at: '2026-09-03T10:00:00Z',
    })
    expect(result).toEqual({ applied: true })
    expect(rows[0].demo_confirmed_at).toBe('2026-09-03T10:00:00Z')
    expect(rows[0].demo_confirmed_phone).toBe('+12345550199')
  })

  it('is idempotent — a second confirm call for the same lead does not overwrite', async () => {
    await confirmOutreachDemoClick(fakeSupabase as never, {
      demoToken: 'a1b2c3d4e5f6',
      phone: '+12345550199',
      at: '2026-09-03T10:00:00Z',
    })
    const second = await confirmOutreachDemoClick(fakeSupabase as never, {
      demoToken: 'a1b2c3d4e5f6',
      phone: '+19999999999',
      at: '2026-09-03T11:00:00Z',
    })
    expect(second).toEqual({ applied: false })
    expect(rows[0].demo_confirmed_phone).toBe('+12345550199')
    expect(updateCalls).toHaveLength(1)
  })

  it('no-ops for a lead already confirmed before this call', async () => {
    const result = await confirmOutreachDemoClick(fakeSupabase as never, {
      demoToken: 'deadbeefcafe',
      phone: '+19999999999',
    })
    expect(result).toEqual({ applied: false })
    expect(rows[1].demo_confirmed_phone).toBe('+12345550100')
  })

  it('no-ops for an unknown demo_token', async () => {
    const result = await confirmOutreachDemoClick(fakeSupabase as never, {
      demoToken: 'ffffffffffff',
      phone: '+19999999999',
    })
    expect(result).toEqual({ applied: false })
  })
})
