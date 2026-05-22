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
      { onConflict: 'user_id,channel_type' }
    )

  if (upsertError) {
    return NextResponse.json({ error: upsertError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, pageName: resolvedName })
}
