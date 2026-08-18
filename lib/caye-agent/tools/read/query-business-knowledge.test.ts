import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: vi.fn() }))

import { rankBusinessFacts, type FactRow } from './query-business-knowledge'

const row = (over: Partial<FactRow> & Pick<FactRow, 'id' | 'fact' | 'created_at'>): FactRow => ({
  category: 'policy',
  source: 'owner-direct',
  expires_at: null,
  ...over,
})

describe('query_business_knowledge ranking', () => {
  it('puts the newer owner fact first when equally relevant facts conflict', () => {
    const oldFact = row({
      id: 'old',
      fact: 'Full Bimini Experience shared tours need 3-4 guests to depart.',
      created_at: '2026-08-10T03:18:38Z',
    })
    const currentFact = row({
      id: 'current',
      fact: 'Full Bimini Experience shared tours have a minimum of 2 guests and maximum of 6 guests.',
      created_at: '2026-08-17T23:41:27Z',
    })

    const ranked = rankBusinessFacts('Full Bimini shared tour guests', [oldFact, currentFact])

    expect(ranked[0]?.id).toBe('current')
  })

  it('does not return expired facts', () => {
    const expired = row({
      id: 'expired',
      fact: 'Full Bimini shared tour old rule',
      created_at: '2026-08-01T00:00:00Z',
      expires_at: '2026-08-12T00:00:00Z',
    })
    const active = row({
      id: 'active',
      fact: 'Full Bimini shared tour current rule',
      created_at: '2026-08-17T00:00:00Z',
    })

    const ranked = rankBusinessFacts(
      'Full Bimini shared tour',
      [expired, active],
      Date.parse('2026-08-18T00:00:00Z')
    )

    expect(ranked.map((item) => item.id)).toEqual(['active'])
  })

  it('uses newest active facts for fallback instead of database row order', () => {
    const older = row({ id: 'older', fact: 'Unrelated alpha', created_at: '2026-08-01T00:00:00Z' })
    const newer = row({ id: 'newer', fact: 'Unrelated beta', created_at: '2026-08-17T00:00:00Z' })

    const ranked = rankBusinessFacts('words that do not overlap', [older, newer])

    expect(ranked[0]?.id).toBe('newer')
  })
})
