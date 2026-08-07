import { describe, it, expect, vi } from 'vitest'

// zoho-inbound-sync.ts transitively imports zoho-calendar.ts / zoho-token.ts,
// both of which have a top-level `import 'server-only'` — neutralize it so
// vitest (node env) can load the module chain, same pattern as
// high-risk-gate.test.ts. countByTitleDate itself never touches Supabase.
vi.mock('server-only', () => ({}))

import { countByTitleDate, BURST_THRESHOLD_PER_DAY } from './zoho-inbound-sync'
import type { ZohoEventSummary } from './zoho-calendar'

function makeEvent(overrides: Partial<ZohoEventSummary>): ZohoEventSummary {
  return {
    uid: `uid_${Math.random()}`,
    title: 'John Smith (2)',
    description: null,
    isAllDay: false,
    startDate: '2026-06-08',
    startTime: '10:00:00',
    durationMinutes: 120,
    ...overrides,
  }
}

describe('countByTitleDate (2026-07-28 — Bimini calendar-flood incident)', () => {
  it('reproduces the incident: a recurring non-booking event floods past the burst threshold', () => {
    // 578 real instances observed in production; a handful is enough to
    // prove the threshold trips.
    const flood = Array.from({ length: 10 }, () =>
      makeEvent({ title: 'Business Update - Bimini Island Tours', startDate: '2026-06-08' })
    )
    const counts = countByTitleDate(flood)
    const count = counts.get('business update - bimini island tours|2026-06-08')
    expect(count).toBe(10)
    expect(count!).toBeGreaterThan(BURST_THRESHOLD_PER_DAY)
  })

  it('does not flag a handful of legitimately same-titled bookings on one day', () => {
    const events = Array.from({ length: BURST_THRESHOLD_PER_DAY }, () =>
      makeEvent({ title: 'John Smith (2)', startDate: '2026-06-08' })
    )
    // parseCustomerFromTitle strips the trailing "(N)" guest-count suffix —
    // the key is on the parsed customer name, not the raw title.
    const count = countByTitleDate(events)!.get('john smith|2026-06-08')
    expect(count).toBe(BURST_THRESHOLD_PER_DAY)
    expect(count!).not.toBeGreaterThan(BURST_THRESHOLD_PER_DAY)
  })

  it('does not combine the same title across different dates', () => {
    const events = [
      makeEvent({ title: 'Weekly Checkup', startDate: '2026-06-01' }),
      makeEvent({ title: 'Weekly Checkup', startDate: '2026-06-08' }),
      makeEvent({ title: 'Weekly Checkup', startDate: '2026-06-15' }),
    ]
    const counts = countByTitleDate(events)
    expect(counts.get('weekly checkup|2026-06-01')).toBe(1)
    expect(counts.get('weekly checkup|2026-06-08')).toBe(1)
    expect(counts.get('weekly checkup|2026-06-15')).toBe(1)
  })

  it('excludes all-day events from the count', () => {
    const events = [
      makeEvent({ title: 'Business Update', startDate: '2026-06-08', isAllDay: true }),
      makeEvent({ title: 'Business Update', startDate: '2026-06-08', isAllDay: true }),
    ]
    const counts = countByTitleDate(events)
    expect(counts.size).toBe(0)
  })

  it('normalizes title casing/whitespace so near-duplicates still count together', () => {
    const events = [
      makeEvent({ title: 'Business Update', startDate: '2026-06-08' }),
      makeEvent({ title: '  BUSINESS UPDATE  ', startDate: '2026-06-08' }),
    ]
    const counts = countByTitleDate(events)
    expect(counts.get('business update|2026-06-08')).toBe(2)
  })
})
