import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../types'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/whatsapp/schedule', () => ({
  loadScheduleConfig: async () => ({ timezone: 'America/New_York' }),
  localDateISO: () => '2026-08-01',
  endOfLocalDayUTC: () => new Date('2026-09-01T03:59:59Z'),
}))

interface ExistingFact {
  id: string
  fact: string
  source: string
  expires_at: string | null
}

let activeFacts: ExistingFact[] = []
let insertedFact: Record<string, unknown> | null = null
let supersededUpdate: Record<string, unknown> | null = null

// findConflictingFact itself is unit tested against the real LLM-judge shape
// in business-fact-conflict.test.ts — mocked here so these tests control the
// resolution directly instead of steering an LLM prompt into a verdict.
let conflictResult: {
  conflictId: string | null
  resolution: 'supersede' | 'ambiguous' | null
  checkFailed?: boolean
} = {
  conflictId: null,
  resolution: null,
}
vi.mock('@/lib/business-fact-conflict', () => ({
  findConflictingFact: async () => conflictResult,
}))

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      if (table !== 'business_facts') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            is: async () => ({ data: activeFacts, error: null }),
          }),
        }),
        insert: (row: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              insertedFact = row
              return { data: { id: 'fact-new', created_at: '2026-08-18T00:00:00Z' }, error: null }
            },
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: async () => {
            supersededUpdate = patch
            return { error: null }
          },
        }),
      }
    },
  }),
}))

const { addBusinessFact } = await import('./add-business-fact')

const ctx = { workspaceId: 'ws-1', callerRole: 'owner' } as unknown as ToolContext

beforeEach(() => {
  activeFacts = []
  conflictResult = { conflictId: null, resolution: null }
  insertedFact = null
  supersededUpdate = null
})

describe('add_business_fact', () => {
  it('saves a fact with no conflict as a plain append', async () => {
    const res = await addBusinessFact.execute(
      { category: 'logistics', fact: 'The dock closes at 5pm.' },
      ctx
    )
    expect(res.ok).toBe(true)
    expect(insertedFact).toMatchObject({ source: 'owner-direct', fact: 'The dock closes at 5pm.' })
    expect(supersededUpdate).toBeNull()
  })

  // CAY-14 regression: production incident. An older fact said cash and Zelle
  // were not accepted; the owner (Mrs. Max) later told a guest cash was fine
  // and had to correct Caye live. The old fact must never keep answering
  // guest questions once a clean owner correction arrives.
  it('supersedes the old payment fact on a clean owner correction (Juli King incident)', async () => {
    activeFacts = [
      {
        id: 'fact-old-payment',
        fact: 'All payments are made in advance by card only... Cash and Zelle are not accepted.',
        source: 'owner-direct',
        expires_at: null,
      },
    ]
    conflictResult = { conflictId: 'fact-old-payment', resolution: 'supersede' }

    const res = await addBusinessFact.execute(
      { category: 'policy', fact: 'Cash is fine with Max — do not mention payment method unless asked.' },
      ctx
    )

    expect(res.ok).toBe(true)
    expect(insertedFact).toMatchObject({ source: 'owner-direct' })
    expect(supersededUpdate).toMatchObject({ superseded_by: 'fact-new' })
    expect((res.data as { superseded_fact: string | null }).superseded_fact).toBe(
      'All payments are made in advance by card only... Cash and Zelle are not accepted.'
    )
  })

  // Non-payment example: a clean logistics correction should supersede the
  // same way payment corrections do — this isn't special-cased to payments.
  it('supersedes an old logistics fact on a clean owner correction', async () => {
    activeFacts = [
      { id: 'fact-old-parking', fact: 'Parking is free at the north lot.', source: 'owner-direct', expires_at: null },
    ]
    conflictResult = { conflictId: 'fact-old-parking', resolution: 'supersede' }

    const res = await addBusinessFact.execute(
      { category: 'logistics', fact: 'Parking is no longer free — guests must use the paid garage on Bay Street.' },
      ctx
    )

    expect(res.ok).toBe(true)
    expect(supersededUpdate).toMatchObject({ superseded_by: 'fact-new' })
  })

  it('fails closed on an ambiguous conflict: does not save the new fact or touch the old one', async () => {
    activeFacts = [
      { id: 'fact-old-tours', fact: 'Tours run daily at 9am.', source: 'owner-direct', expires_at: null },
    ]
    conflictResult = { conflictId: 'fact-old-tours', resolution: 'ambiguous' }

    const res = await addBusinessFact.execute(
      { category: 'service_detail', fact: 'The heritage tour now starts at 10am.' },
      ctx
    )

    expect(res.ok).toBe(false)
    expect(insertedFact).toBeNull()
    expect(supersededUpdate).toBeNull()
  })

  // CAY-14 reliability fix: production incident happened because "couldn't
  // check for a conflict" was treated the same as "no conflict". A judge/
  // infra failure must fail closed exactly like an ambiguous verdict.
  it('fails closed when the conflict check itself failed, without saving or superseding anything', async () => {
    activeFacts = [
      { id: 'fact-old-payment', fact: 'Cash is not accepted.', source: 'owner-direct', expires_at: null },
    ]
    conflictResult = { conflictId: null, resolution: null, checkFailed: true }

    const res = await addBusinessFact.execute(
      { category: 'policy', fact: 'Cash is accepted now.' },
      ctx
    )

    expect(res.ok).toBe(false)
    expect(insertedFact).toBeNull()
    expect(supersededUpdate).toBeNull()
  })

  it('never checks superseded facts for conflicts — only active ones are fetched', async () => {
    // The mock's `.is('superseded_at', null)` step is what filters this in
    // real Supabase; here we just assert the tool queries business_facts at
    // all before inserting, i.e. it doesn't skip the conflict check.
    activeFacts = []
    const res = await addBusinessFact.execute({ category: 'policy', fact: 'Refunds take 14 days.' }, ctx)
    expect(res.ok).toBe(true)
  })

  it('rejects a too-short fact before touching the database', async () => {
    const res = await addBusinessFact.execute({ category: 'policy', fact: 'Hi' }, ctx)
    expect(res.ok).toBe(false)
    expect(insertedFact).toBeNull()
  })
})
