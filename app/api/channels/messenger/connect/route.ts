import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

  const { workspaceId, pageId, accessToken, pageName } = body as {
    workspaceId: string
    pageId: string
    accessToken: string
    pageName?: string
  }

  if (!workspaceId || !pageId || !accessToken) {
    return NextResponse.json(
      { error: 'workspaceId, pageId, and accessToken are required' },
      { status: 400 }
    )
  }

  // Validate the Page ID and access token against the Meta Graph API
  let resolvedName: string
  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${encodeURIComponent(pageId)}?fields=name,id&access_token=${encodeURIComponent(accessToken)}`
    )
    const json = (await res.json()) as Record<string, unknown>
    if (json.error || !json.id) {
      return NextResponse.json({ error: 'Invalid Page ID or access token' }, { status: 400 })
    }
    resolvedName = (json.name as string) ?? pageId
  } catch {
    return NextResponse.json({ error: 'Failed to verify with Meta API' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Deactivate any existing messenger connections for this workspace
  // that point to a different page (same pattern as Zoho callback)
  await supabase
    .from('connected_accounts')
    .update({ is_active: false, needs_reauth: false })
    .eq('user_id', workspaceId)
    .eq('channel_type', 'messenger')
    .neq('channel_account_id', pageId)

  const { error: upsertError } = await supabase
    .from('connected_accounts')
    .upsert(
      {
        user_id: workspaceId,
        channel_type: 'messenger',
        channel_account_id: pageId,
        channel_account_name: pageName || resolvedName,
        channel_username: resolvedName,
        access_token: accessToken,
        is_active: true,
        needs_reauth: false,
        metadata: { page_id: pageId, page_name: resolvedName },
      },
      { onConflict: 'channel_type,channel_account_id' }
    )

  if (upsertError) {
    console.error('[messenger/connect] upsert error:', upsertError)
    return NextResponse.json({ error: upsertError.message }, { status: 500 })
  }

  // Subscribe the page to the app's webhook so Meta delivers message events
  try {
    const subRes = await fetch(
      `https://graph.facebook.com/v19.0/${encodeURIComponent(pageId)}/subscribed_apps` +
        `?subscribed_fields=messages&access_token=${encodeURIComponent(accessToken)}`,
      { method: 'POST' }
    )
    const subData = (await subRes.json()) as Record<string, unknown>
    if (!subData.success) {
      console.error('[messenger/connect] Page webhook subscription failed:', subData)
    } else {
      console.log(`[messenger/connect] Page ${pageId} subscribed to webhook`)
    }
  } catch (err) {
    console.error('[messenger/connect] Page webhook subscription error:', err)
  }

  return NextResponse.json({ success: true, pageName: resolvedName })
}
