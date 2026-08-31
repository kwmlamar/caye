import type { Metadata } from 'next'
import { CayeMark } from '@/components/brand/CayeMark'
import { verifyConnectToken, connectPathFor } from '@/lib/channels/connect-token'
import { isConnectChannel } from '@/lib/channels/channel-types'
import { androidIntentUrl } from '@/lib/channels/embedded-browser'

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

const CHANNEL_NAME: Record<string, string> = {
  gmail: 'Gmail',
  zoho: 'Zoho Mail',
  instagram: 'Instagram',
  messenger: 'Messenger',
}

/**
 * Shown only to in-app browsers (see lib/channels/embedded-browser).
 *
 * Google refuses OAuth inside an embedded WebView as a matter of policy,
 * and a tap from WhatsApp on Android opens exactly that. Without this the
 * user lands on a Google error page with no way forward, at the precise
 * moment they're trying to activate. Everyone on a real browser is
 * redirected straight through and never sees this.
 *
 * The `ext=1` on the outbound link is what stops the loop: the initiator
 * skips its browser check when it's set, so the freshly-opened real
 * browser goes straight to the provider. `source` must survive this hop
 * too, or a WhatsApp walkthrough gets mistaken for a dashboard connect.
 */
export default async function ConnectOpenPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; channel?: string; source?: string }>
}) {
  const { t, channel, source } = await searchParams
  const verified = verifyConnectToken(t)

  if (!verified.ok || !channel || !isConnectChannel(channel)) {
    return (
      <div className="login-root login-dark">
        <div className="login-card" style={{ textAlign: 'center' }}>
          <div className="login-brand" style={{ justifyContent: 'center' }}>
            <CayeMark size={36} />
          </div>
          <h1 className="login-heading">That link didn&apos;t work</h1>
          <p className="login-sub">
            Message Caye on WhatsApp and she&apos;ll send you a fresh one.
          </p>
        </div>
      </div>
    )
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.meetcaye.com'
  const path = connectPathFor(channel)
  const sep = path.includes('?') ? '&' : '?'
  const sourceParam = source ? `&source=${encodeURIComponent(source)}` : ''
  const target = `${appUrl}${path}${sep}t=${encodeURIComponent(t!)}&ext=1${sourceParam}`
  const name = CHANNEL_NAME[channel] ?? 'your account'

  return (
    <div className="login-root login-dark">
      <div className="login-card" style={{ textAlign: 'center' }}>
        <div className="login-brand" style={{ justifyContent: 'center' }}>
          <CayeMark size={36} />
        </div>

        <span className="login-eyebrow">One tap</span>
        <h1 className="login-heading">Open this in your browser</h1>
        <p className="login-sub">
          {name} won&apos;t let you sign in from inside WhatsApp — it needs a real browser.
          Tap below and you&apos;ll be right back.
        </p>

        {/* Android hands intent:// to the system, which opens the default
            browser. iOS ignores the scheme, so the plain link below is the
            path there — and iOS in-app browsers usually allow OAuth anyway. */}
        <a
          href={androidIntentUrl(target)}
          className="btn-primary"
          style={{ width: '100%', justifyContent: 'center', textDecoration: 'none' }}
        >
          Open in browser
        </a>

        <p style={{ fontSize: 13, color: 'rgba(245,245,244,0.45)', marginTop: 18 }}>
          Nothing happened?{' '}
          <a href={target} style={{ color: 'var(--tc-sun)', fontWeight: 600, textDecoration: 'none' }}>
            Try this link
          </a>
          , or use the menu in the corner and pick &ldquo;Open in browser&rdquo;.
        </p>
      </div>
    </div>
  )
}
