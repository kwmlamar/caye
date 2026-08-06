/**
 * Channel identifiers shared by server and client code.
 *
 * Deliberately free of 'server-only' so client components (the dashboard
 * Connect buttons) can import the type and the guard without pulling in
 * lib/channels/connect-token, which holds the HMAC key material and must
 * never reach a browser bundle.
 *
 * These name the *OAuth provider being connected*, which is not always the
 * `connected_accounts.channel_type` written afterwards — Zoho's rows are
 * stored as channel_type 'email'. See lib/channels/slots.ts for the
 * logical-slot mapping that reconciles the two.
 */
export type ConnectChannel = 'gmail' | 'zoho' | 'instagram' | 'messenger' | 'whatsapp'

export const CONNECT_CHANNELS: ConnectChannel[] = [
  'gmail',
  'zoho',
  'instagram',
  'messenger',
  'whatsapp',
]

export function isConnectChannel(v: string): v is ConnectChannel {
  return (CONNECT_CHANNELS as string[]).includes(v)
}
