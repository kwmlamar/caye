import { NextRequest, NextResponse } from 'next/server'
import { getWorkspaceIdServer } from '@/lib/supabase-server'
import { buildConnectUrl, isConnectChannel } from '@/lib/channels/connect-token'

/**
 * Mints a signed connect link for a dashboard user.
 *
 * The OAuth initiators no longer accept a bare `?workspaceId=` (see
 * lib/channels/connect-token), so the in-app "Connect" buttons ask for a
 * token here first. This is the one place the workspace-membership check
 * lives: the caller proves they belong to the workspace with their
 * Supabase session, and only then do they get a capability for it.
 *
 * Caye's WhatsApp links don't come through here — she mints server-side
 * via the send_connect_link tool, where the operator allowlist has already
 * established who she's talking to.
 */
export async function POST(req: NextRequest) {
  const accessToken = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  let body: { workspaceId?: string; channel?: string; source?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const { workspaceId, channel, source } = body
  if (!workspaceId || !channel || !isConnectChannel(channel)) {
    return NextResponse.json({ error: 'Missing or unknown workspaceId/channel' }, { status: 400 })
  }

  const { customerId, error } = await getWorkspaceIdServer(accessToken, workspaceId)
  if (error || customerId !== workspaceId) {
    return NextResponse.json({ error: 'No access to that workspace' }, { status: 403 })
  }

  return NextResponse.json({ url: buildConnectUrl(workspaceId, channel, { source }) })
}
