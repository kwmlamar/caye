import { getSession } from '@/lib/supabase'
import type { ConnectChannel } from './channel-types'

/**
 * Client-side helper for the in-app "Connect" buttons.
 *
 * The OAuth initiators stopped accepting a bare `?workspaceId=` (see
 * lib/channels/connect-token), so a dashboard button can no longer just
 * set window.location. It exchanges the user's session for a signed,
 * workspace-scoped token first, then navigates.
 *
 * Returns an error string instead of throwing so callers can toast it —
 * a silent no-op on a Connect button is the worst possible outcome here.
 */
export async function startConnectFlow(
  workspaceId: string,
  channel: ConnectChannel,
  source?: string
): Promise<string | null> {
  const { session } = await getSession()
  if (!session?.access_token) return 'Please sign in again to connect this channel.'

  let res: Response
  try {
    res = await fetch('/api/channels/connect-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ workspaceId, channel, source }),
    })
  } catch {
    return 'Network error — check your connection and try again.'
  }

  const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string }
  if (!res.ok || !data.url) return data.error ?? 'Could not start the connection.'

  window.location.href = data.url
  return null
}
