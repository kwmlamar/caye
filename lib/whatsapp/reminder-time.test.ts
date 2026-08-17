import { describe, it, expect } from 'vitest'
import {
  localDateTimeToUTC,
  resolveReminderTime,
  formatReminderBody,
  describeReminderTime,
  MAX_LEAD_DAYS,
} from './reminder-time'

const NASSAU = 'America/Nassau' // UTC-4 in summer (EDT), UTC-5 in winter (EST)

describe('localDateTimeToUTC', () => {
  // The reminder Mrs. Max actually asked for: 8:30 tomorrow, Bimini time.
  it('converts a summer morning in Nassau (UTC-4)', () => {
    const utc = localDateTimeToUTC('2026-08-10', '08:30', NASSAU)
    expect(utc.toISOString()).toBe('2026-08-10T12:30:00.000Z')
  })

  it('converts her second one, 9:30', () => {
    expect(localDateTimeToUTC('2026-08-10', '09:30', NASSAU).toISOString()).toBe(
      '2026-08-10T13:30:00.000Z'
    )
  })

  // Winter is a different offset — a fixed -4 would silently drift by an hour
  // for half the year, which is exactly the kind of bug nobody reports and
  // everybody stops trusting.
  it('respects standard time in winter (UTC-5)', () => {
    expect(localDateTimeToUTC('2026-12-14', '08:30', NASSAU).toISOString()).toBe(
      '2026-12-14T13:30:00.000Z'
    )
  })

  it('handles midnight without rolling the date', () => {
    expect(localDateTimeToUTC('2026-08-10', '00:00', NASSAU).toISOString()).toBe(
      '2026-08-10T04:00:00.000Z'
    )
  })

  it('round-trips through the DST spring-forward boundary', () => {
    // 2026-03-08 02:00 local does not exist in Nassau; must not produce NaN.
    const utc = localDateTimeToUTC('2026-03-08', '03:00', NASSAU)
    expect(Number.isNaN(utc.getTime())).toBe(false)
  })
})

describe('resolveReminderTime', () => {
  const now = new Date('2026-08-09T22:00:00.000Z') // 6pm Nassau

  it('accepts tomorrow morning', () => {
    const r = resolveReminderTime({ dateISO: '2026-08-10', timeHHMM: '08:30', timezone: NASSAU, now })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.fireAtUTC.toISOString()).toBe('2026-08-10T12:30:00.000Z')
      expect(r.leadMinutes).toBe(870) // 14.5h
    }
  })

  it('rejects a malformed date in words the operator can act on', () => {
    const r = resolveReminderTime({ dateISO: 'tomorrow', timeHHMM: '08:30', timezone: NASSAU, now })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('YYYY-MM-DD')
  })

  it('rejects a 12-hour time', () => {
    const r = resolveReminderTime({ dateISO: '2026-08-10', timeHHMM: '8:30am', timezone: NASSAU, now })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('HH:MM')
  })

  // A past reminder is nearly always a year slip, so the error says so.
  it('rejects a time already gone and points at the date', () => {
    const r = resolveReminderTime({ dateISO: '2025-08-10', timeHHMM: '08:30', timezone: NASSAU, now })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/check the date/i)
  })

  it('rejects something absurdly far out', () => {
    const r = resolveReminderTime({ dateISO: '2030-01-01', timeHHMM: '08:30', timezone: NASSAU, now })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(String(MAX_LEAD_DAYS))
  })
})

describe('formatReminderBody', () => {
  it('marks it as something she asked for, not a new problem', () => {
    const body = formatReminderBody('meeting at 8:30')
    expect(body).toMatch(/reminder you asked me to set/i)
    expect(body).toContain('meeting at 8:30')
  })

  it('collapses whitespace and caps length', () => {
    expect(formatReminderBody('a\n\n  b')).toContain('a b')
    expect(formatReminderBody('x'.repeat(2000)).length).toBeLessThanOrEqual(900)
  })

  it('carries no decorative emoji, matching the house style ban', () => {
    // back-office.ts: "NO decorative emoji ever ... Status is a plain word."
    // This template bypasses that prompt entirely (deterministic, not
    // LLM-composed), so the ban has to be enforced here too.
    // eslint-disable-next-line no-control-regex
    expect(formatReminderBody('meeting at 8:30')).toMatch(/^[\x00-\x7F]*$/)
  })
})

describe('describeReminderTime', () => {
  it('confirms back in the operator\'s own local time, not UTC', () => {
    const s = describeReminderTime(new Date('2026-08-10T12:30:00.000Z'), NASSAU)
    expect(s).toContain('8:30')
    expect(s).toContain('AM')
    expect(s).toContain('Aug 10')
  })
})
