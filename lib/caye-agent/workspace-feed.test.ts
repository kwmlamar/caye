import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { isReportable, isBounceAddress } = await import('./workspace-feed')

describe('isBounceAddress', () => {
  // The 2026-08-06 shape: two of the three most recent "inbound messages"
  // on TropiTech Outreach were bounces. "Who last emailed you?" must not
  // answer "mailer-daemon".
  it('catches the bounce senders seen in prod', () => {
    expect(isBounceAddress('mailer-daemon@googlemail.com')).toBe(true)
    expect(isBounceAddress('mailer-daemon@mail.zoho.com')).toBe(true)
  })

  it('catches postmaster and no-reply variants', () => {
    expect(isBounceAddress('postmaster@example.com')).toBe(true)
    expect(isBounceAddress('no-reply@booking.com')).toBe(true)
    expect(isBounceAddress('noreply@booking.com')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isBounceAddress('MAILER-DAEMON@Googlemail.com')).toBe(true)
  })

  it('does not swallow real prospects', () => {
    expect(isBounceAddress('zanzi2go@gmail.com')).toBe(false)
    expect(isBounceAddress('info@totalsnorkelcancun.com')).toBe(false)
    expect(isBounceAddress('bookings@safariblue.net')).toBe(false)
  })

  it('handles missing addresses', () => {
    expect(isBounceAddress(null)).toBe(false)
    expect(isBounceAddress(undefined)).toBe(false)
    expect(isBounceAddress('')).toBe(false)
  })
})

describe('isReportable', () => {
  it('reports what the outside world did', () => {
    expect(isReportable({ actorKind: 'outside', isFailure: false })).toBe(true)
  })

  it('stays silent on Caye\'s own successful sends', () => {
    expect(isReportable({ actorKind: 'caye', isFailure: false })).toBe(false)
  })

  it('stays silent on the operator\'s own successful actions', () => {
    expect(isReportable({ actorKind: 'operator', isFailure: false })).toBe(false)
  })

  it('stays silent on unattributed sends rather than guessing they matter', () => {
    expect(isReportable({ actorKind: 'unknown', isFailure: false })).toBe(false)
  })

  // "Something that was supposed to happen and didn't" is reportable no
  // matter who caused it — a cron that failed means the feed itself is
  // lying about everything else.
  it('reports failures regardless of actor', () => {
    expect(isReportable({ actorKind: 'system', isFailure: true })).toBe(true)
    expect(isReportable({ actorKind: 'caye', isFailure: true })).toBe(true)
    expect(isReportable({ actorKind: 'operator', isFailure: true })).toBe(true)
    expect(isReportable({ actorKind: 'unknown', isFailure: true })).toBe(true)
  })

  it('does not report routine system activity that succeeded', () => {
    expect(isReportable({ actorKind: 'system', isFailure: false })).toBe(false)
  })
})
