import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('server-only', () => ({}))

process.env.CONNECT_LINK_SECRET = 'test-secret-for-connect-links'
process.env.NEXT_PUBLIC_APP_URL = 'https://example.test'

const { mintConnectToken, verifyConnectToken, buildConnectUrl } = await import('./connect-token')

const WS = '11111111-2222-3333-4444-555555555555'

describe('mint/verify round trip', () => {
  it('recovers the workspace and channel', () => {
    const r = verifyConnectToken(mintConnectToken(WS, 'gmail'))
    expect(r).toEqual({ ok: true, workspaceId: WS, channel: 'gmail' })
  })

  it('rejects a tampered payload', () => {
    const [, sig] = mintConnectToken(WS, 'gmail').split('.')
    const forged = Buffer.from(
      JSON.stringify({ w: 'someone-elses-workspace', c: 'gmail', e: 9999999999 })
    ).toString('base64url')
    expect(verifyConnectToken(`${forged}.${sig}`)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects garbage and empty input', () => {
    expect(verifyConnectToken(null)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyConnectToken('')).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyConnectToken('nodot')).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyConnectToken('a.b')).toEqual({ ok: false, reason: 'bad_signature' })
  })
})

describe('channel binding', () => {
  it('refuses an Instagram token replayed against the Gmail initiator', () => {
    const token = mintConnectToken(WS, 'instagram')
    expect(verifyConnectToken(token, 'gmail')).toEqual({ ok: false, reason: 'channel_mismatch' })
    expect(verifyConnectToken(token, 'instagram')).toMatchObject({ ok: true })
  })
})

describe('expiry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('accepts inside the window and rejects past it', () => {
    vi.setSystemTime(new Date('2026-08-06T00:00:00Z'))
    const token = mintConnectToken(WS, 'zoho', 7)

    vi.setSystemTime(new Date('2026-08-12T23:00:00Z')) // day 6
    expect(verifyConnectToken(token)).toMatchObject({ ok: true })

    vi.setSystemTime(new Date('2026-08-13T01:00:00Z')) // past day 7
    expect(verifyConnectToken(token)).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('buildConnectUrl', () => {
  it('deep-links straight to the OAuth initiator for link-able channels', () => {
    const url = buildConnectUrl(WS, 'gmail', { source: 'wa' })
    expect(url.startsWith('https://example.test/api/auth/gmail?t=')).toBe(true)
    expect(url).toContain('&source=wa')
  })

  it('keeps the meta channel param intact', () => {
    expect(buildConnectUrl(WS, 'instagram')).toContain('/api/auth/meta?channel=instagram&t=')
  })

  it('routes WhatsApp to /connect — Embedded Signup cannot be a link', () => {
    const url = buildConnectUrl(WS, 'whatsapp')
    expect(url).toContain('/connect?only=whatsapp&t=')
    expect(url).not.toContain('/api/auth/')
  })

  it('produces a token the redeeming route will accept', () => {
    const url = new URL(buildConnectUrl(WS, 'messenger'))
    expect(verifyConnectToken(url.searchParams.get('t'), 'messenger')).toMatchObject({
      ok: true,
      workspaceId: WS,
    })
  })
})
