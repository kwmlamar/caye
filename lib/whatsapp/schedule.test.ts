import { describe, it, expect, vi } from 'vitest'
// vi.mock is hoisted above this import, so the 'server-only' guard is
// already neutralized when the module loads (vitest runs in node env).
import { endOfLocalDayUTC, localDateISO } from './schedule'

vi.mock('server-only', () => ({}))

const NASSAU = 'America/Nassau'

describe('endOfLocalDayUTC', () => {
  it('keeps a fact alive through the whole local day the owner named', () => {
    // The bug this exists to prevent: storing `${date}T00:00:00Z` meant a
    // fact set to expire on the 15th died at 8pm local on the 14th, so Caye
    // would tell guests the business was open while it was still closed.
    const expiry = endOfLocalDayUTC('2026-08-15', NASSAU)

    // 11:30pm local on the 15th — still inside the owner's "the 15th".
    expect(new Date('2026-08-16T03:30:00Z').getTime()).toBeLessThan(expiry.getTime())
    // 12:30am local on the 16th — now genuinely past it.
    expect(new Date('2026-08-16T04:30:00Z').getTime()).toBeGreaterThan(expiry.getTime())
  })

  it('never expires before the named date has started locally', () => {
    const expiry = endOfLocalDayUTC('2026-08-15', NASSAU)
    // 12:01am local on the 15th.
    expect(new Date('2026-08-15T04:01:00Z').getTime()).toBeLessThan(expiry.getTime())
  })

  it('resolves the offset per-date so DST is not hardcoded', () => {
    // Nassau observes DST: EDT (UTC-4) in August, EST (UTC-5) in January.
    // A fixed offset would put these the same distance from midnight UTC.
    const summer = endOfLocalDayUTC('2026-08-15', NASSAU)
    const winter = endOfLocalDayUTC('2026-01-15', NASSAU)
    const summerOffsetH = (summer.getTime() - new Date('2026-08-16T00:00:00Z').getTime()) / 3600000
    const winterOffsetH = (winter.getTime() - new Date('2026-01-16T00:00:00Z').getTime()) / 3600000
    expect(Math.round(summerOffsetH)).toBe(4)
    expect(Math.round(winterOffsetH)).toBe(5)
  })
})

describe('localDateISO', () => {
  it('reports the local date, not the UTC one, late in the evening', () => {
    // 9pm Nassau on Aug 14 is already Aug 15 in UTC. add_business_fact's
    // past-date guard uses this, so the UTC answer would reject an owner
    // trying to set something to expire "today".
    expect(localDateISO(new Date('2026-08-15T01:00:00Z'), NASSAU)).toBe('2026-08-14')
  })

  it('agrees with UTC during local daytime', () => {
    expect(localDateISO(new Date('2026-08-15T16:00:00Z'), NASSAU)).toBe('2026-08-15')
  })
})
