import { CayeMark } from '@/components/brand/CayeMark'

export const dynamic = 'force-dynamic'

const CHANNEL_NAME: Record<string, string> = {
  gmail: 'Gmail',
  zoho: 'Zoho Mail',
  instagram: 'Instagram',
  messenger: 'Messenger',
  whatsapp: 'WhatsApp',
}

/**
 * Where an OAuth callback lands someone who tapped a link Caye texted
 * (source=wa). There is deliberately nothing to do here and nowhere to go:
 * the next step is already sitting in their WhatsApp, sent by the callback
 * itself (lib/channels/connect-progress). A "go to dashboard" button here
 * would pull them out of the walkthrough mid-flow, which is exactly the
 * leak this page replaces.
 */
export default async function ConnectDonePage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string; [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const channel = typeof params.channel === 'string' ? params.channel : ''
  const name = CHANNEL_NAME[channel] ?? 'That channel'

  // The callbacks pass their outcome as a bare `<channel>_error=<reason>`
  // or `<channel>_connected=1` query param — see app/api/auth/*/callback.
  const failed = Object.keys(params).some((k) => k.endsWith('_error'))

  return (
    <div className="login-root login-dark">
      <div className="login-card" style={{ textAlign: 'center' }}>
        <div className="login-brand" style={{ justifyContent: 'center' }}>
          <CayeMark size={36} />
        </div>

        {failed ? (
          <>
            <span className="login-eyebrow">Didn&apos;t go through</span>
            <h1 className="login-heading">{name} isn&apos;t connected</h1>
            <p className="login-sub">
              Nothing was changed. Head back to WhatsApp and tell Caye it didn&apos;t work —
              she&apos;ll sort it out or send a fresh link.
            </p>
          </>
        ) : (
          <>
            <span className="login-eyebrow">Connected</span>
            <h1 className="login-heading">{name} is hooked up</h1>
            <p className="login-sub">
              You can close this tab — Caye&apos;s already messaged you on WhatsApp with what&apos;s
              next.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
