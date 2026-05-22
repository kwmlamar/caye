import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

  const { workspaceId, instagramBusinessId, accessToken, instagramName } = body as {
    workspaceId: string
    instagramBusinessId: string
    accessToken: string
    instagramName?: string
  }

  if (!workspaceId || !instagramBusinessId || !accessToken) {
    return NextResponse.json(
      { error: 'workspaceId, instagramBusinessId, and accessToken are required' },
      { status: 400 }
    )
  }

  // Validate the Instagram Business Account ID and page access token against the Meta Graph API
  let resolvedName: string
  let resolvedUsername: string
  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${encodeURIComponent(instagramBusinessId)}?fields=name,username&access_token=${encodeURIComponent(accessToken)}`
    )
    const json = (await res.json()) as Record<string, unknown>
    if (json.error || !json.id) {
      console.error('[instagram/connect] validation error:', json.error)
      return NextResponse.json({ error: 'Invalid Instagram Business Account ID or access token' }, { status: 400 })
    }
    resolvedUsername = (json.username as string) ?? instagramBusinessId
    resolvedName = (json.name as string) ?? resolvedUsername
  } catch (err) {
    console.error('[instagram/connect] validation exception:', err)
    return NextResponse.json({ error: 'Failed to verify with Meta API' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Deactivate any existing instagram connections for this workspace
  // that point to a different Instagram Business Account
  await supabase
    .from('connected_accounts')
    .update({ is_active: false, needs_reauth: false })
    .eq('user_id', workspaceId)
    .eq('channel_type', 'instagram')
    .neq('channel_account_id', instagramBusinessId)

  const { error: upsertError } = await supabase
    .from('connected_accounts')
    .upsert(
      {
        user_id: workspaceId,
        channel_type: 'instagram',
        channel_account_id: instagramBusinessId,
        channel_account_name: instagramName || resolvedName,
        channel_username: resolvedUsername,
        access_token: accessToken,
        is_active: true,
        needs_reauth: false,
        metadata: { instagram_business_id: instagramBusinessId, instagram_username: resolvedUsername, instagram_name: resolvedName },
      },
      { onConflict: 'channel_type,channel_account_id' }
    )

  if (upsertError) {
    console.error('[instagram/connect] upsert error:', upsertError)
    return NextResponse.json({ error: upsertError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, instagramName: resolvedName })
}
