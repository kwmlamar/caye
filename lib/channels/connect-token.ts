import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ConnectChannel } from './channel-types'

/**
 * Signed, expiring capability tokens for OAuth connect links.
 *
 * These links used to carry a bare `?workspaceId=<uuid>`, which was
 * tolerable only because the sole thing that produced them was a
 * login-walled dashboard. Caye now *texts* them, which puts standing
 * "attach a mailbox to this workspace" authority into WhatsApp messages —
 * forwardable, screenshotted, in cloud backups, readable on an unlocked
 * phone, and valid forever.
 *
 * The realistic failure isn't an attacker; it's the owner forwarding a
 * link with "here, you set it up" and the wrong mailbox getting attached,
 * or an employee who leaves in March still holding a live link.
 *
 * Expiry is nearly free here because Caye can re-mint on request (see the
 * send_connect_link tool) — "send it again" replaces the whole
 * expired-link support path.
 */

export { CONNECT_CHANNELS, isConnectChannel } from './channel-types'
export type { ConnectChannel } from './channel-types'

/** Long enough to survive a weekend; short enough that an old screenshot is inert. */
export const DEFAULT_TTL_DAYS = 7

interface TokenPayload {
  w: string // workspaceId
  c: ConnectChannel
  e: number // expiry, epoch seconds
}

/**
 * Prefers a dedicated CONNECT_LINK_SECRET. Falls back to a *derived* key
 * rather than the service-role key itself — domain separation means a
 * token signature can never be confused with, or used to forge, anything
 * else signed with that key. The fallback exists so that shipping this
 * without setting a new env var degrades to "still signed" rather than
 * "every connect link 500s", which is the failure mode that would
 * actually hurt.
 */
function signingKey(): Buffer {
  const dedicated = process.env.CONNECT_LINK_SECRET
  if (dedicated) return Buffer.from(dedicated, 'utf8')

  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!service) throw new Error('connect-token: no CONNECT_LINK_SECRET or SUPABASE_SERVICE_ROLE_KEY')
  return createHmac('sha256', service).update('caye-connect-link-v1').digest()
}

const b64url = (buf: Buffer) => buf.toString('base64url')

function sign(body: string): string {
  return b64url(createHmac('sha256', signingKey()).update(body).digest())
}

export function mintConnectToken(
  workspaceId: string,
  channel: ConnectChannel,
  ttlDays: number = DEFAULT_TTL_DAYS
): string {
  const payload: TokenPayload = {
    w: workspaceId,
    c: channel,
    e: Math.floor(Date.now() / 1000) + Math.round(ttlDays * 86400),
  }
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `${body}.${sign(body)}`
}

export type VerifyResult =
  | { ok: true; workspaceId: string; channel: ConnectChannel }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'channel_mismatch' }

/**
 * `expectedChannel` binds a token to the route redeeming it, so an
 * Instagram link can't be replayed against the Gmail initiator.
 */
export function verifyConnectToken(
  token: string | null | undefined,
  expectedChannel?: ConnectChannel
): VerifyResult {
  if (!token || !token.includes('.')) return { ok: false, reason: 'malformed' }

  const [body, sig] = token.split('.', 2)
  if (!body || !sig) return { ok: false, reason: 'malformed' }

  // Constant-time compare, guarded on length — timingSafeEqual throws on
  // mismatched buffer sizes, which would itself leak length by exception.
  const expected = Buffer.from(sign(body), 'utf8')
  const given = Buffer.from(sig, 'utf8')
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad_signature' }
  }

  let payload: TokenPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  if (!payload?.w || !payload?.c || typeof payload.e !== 'number') {
    return { ok: false, reason: 'malformed' }
  }
  if (payload.e < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' }
  if (expectedChannel && payload.c !== expectedChannel) {
    return { ok: false, reason: 'channel_mismatch' }
  }

  return { ok: true, workspaceId: payload.w, channel: payload.c }
}

/** The route that redeems a token for a given channel. */
export function connectPathFor(channel: ConnectChannel): string {
  switch (channel) {
    case 'gmail':
      return '/api/auth/gmail'
    case 'zoho':
      return '/api/auth/zoho'
    default:
      return `/api/auth/meta?channel=${channel}`
  }
}

/**
 * Full URL Caye texts. WhatsApp is deliberately absent from the deep-link
 * path elsewhere in the flow — Embedded Signup is a JS SDK popup and
 * cannot be a link — so callers route 'whatsapp' to /connect instead.
 */
export function buildConnectUrl(
  workspaceId: string,
  channel: ConnectChannel,
  opts: { source?: string; ttlDays?: number; appUrl?: string } = {}
): string {
  const appUrl = opts.appUrl || process.env.NEXT_PUBLIC_APP_URL || 'https://www.meetcaye.com'
  const token = mintConnectToken(workspaceId, channel, opts.ttlDays)

  if (channel === 'whatsapp') {
    return `${appUrl}/connect?only=whatsapp&t=${encodeURIComponent(token)}`
  }

  const path = connectPathFor(channel)
  const sep = path.includes('?') ? '&' : '?'
  const source = opts.source ? `&source=${encodeURIComponent(opts.source)}` : ''
  return `${appUrl}${path}${sep}t=${encodeURIComponent(token)}${source}`
}
