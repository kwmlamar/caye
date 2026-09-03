import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: vi.fn() }))

const { perceptionFreshnessExpired } = await import('./perception-status')

describe('perception status freshness', () => {
  const now = Date.parse('2026-08-30T12:00:00.000Z')

  it('treats an expired freshness deadline as stale evidence', () => {
    expect(perceptionFreshnessExpired('2026-08-30T11:59:59.000Z', now)).toBe(true)
  })

  it('keeps a future freshness deadline current', () => {
    expect(perceptionFreshnessExpired('2026-08-30T12:00:01.000Z', now)).toBe(false)
  })

  it('does not invent staleness when a source has no freshness deadline', () => {
    expect(perceptionFreshnessExpired(null, now)).toBe(false)
  })

  it('fails safe on malformed timestamps instead of manufacturing stale state', () => {
    expect(perceptionFreshnessExpired('not-a-date', now)).toBe(false)
  })
})
