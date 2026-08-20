import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

interface Row {
  sent_at: string
  metadata: Record<string, unknown>
}

let rows: Row[] = []

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from() {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        gte: (_column: string, cutoff: string) => {
          rows = rows.filter((row) => row.sent_at >= cutoff)
          return chain
        },
        order: () => chain,
        limit: async () => ({ data: rows, error: null }),
      })
      return chain
    },
  }),
}))

import { hasRecentManualOutboundEvidence } from './handled'

const now = new Date('2026-08-20T00:30:00.000Z')

describe('CAY-111 handled completion evidence', () => {
  it('does not treat intent alone as completion when no outbound has synced', async () => {
    rows = []
    expect(await hasRecentManualOutboundEvidence({} as never, 'conv-1', now)).toBe(false)
  })

  it('accepts a recent human Zoho outbound as completion evidence', async () => {
    rows = [
      {
        sent_at: '2026-08-20T00:17:58.972Z',
        metadata: { source: 'zoho_sent', sent_by: 'human' },
      },
    ]
    const fake = {
      from() {
        const chain: Record<string, unknown> = {}
        Object.assign(chain, {
          select: () => chain,
          eq: () => chain,
          gte: () => chain,
          order: () => chain,
          limit: async () => ({ data: rows, error: null }),
        })
        return chain
      },
    }
    expect(await hasRecentManualOutboundEvidence(fake as never, 'conv-1', now)).toBe(true)
  })

  it('does not count a Caye-authored outbound as proof the owner handled it directly', async () => {
    rows = [
      {
        sent_at: '2026-08-20T00:20:00.000Z',
        metadata: { generated_by: 'caye', sent_by: 'caye-operator-wa' },
      },
    ]
    const fake = {
      from() {
        const chain: Record<string, unknown> = {}
        Object.assign(chain, {
          select: () => chain,
          eq: () => chain,
          gte: () => chain,
          order: () => chain,
          limit: async () => ({ data: rows, error: null }),
        })
        return chain
      },
    }
    expect(await hasRecentManualOutboundEvidence(fake as never, 'conv-1', now)).toBe(false)
  })
})
