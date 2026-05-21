import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

  const { workspaceId, phoneNumberId, accessToken, displayName } = body as {
    workspaceId: string
    phoneNumberId: string
    accessToken: string
    displayName?: string
  }

  if (!workspaceId || !phoneNumberId || !accessToken) {
    return NextResponse.json({ error: 'workspaceId, phoneNumberId, and accessToken are required' }, { status: 400 })
  }

  let metaData: { display_phone_number: string; verified_name: string }
  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name&access_token=${encodeURIComponent(accessToken)}`
    )
    const json = await res.json() as Record<string, unknown>
    if (json.error || !json.display_phone_number) {
      return NextResponse.json({ error: 'Invalid Phone Number ID or access token' }, { status: 400 })
    }
    metaData = {
      display_phone_number: json.display_phone_number as string,
      verified_name: (json.verified_name as string) ?? '',
    }
  } catch {
    return NextResponse.json({ error: 'Invalid Phone Number ID or access token' }, { status: 400 })
  }

  const { display_phone_number, verified_name } = metaData
  const supabase = createServiceClient()

  const { error: upsertError } = await supabase
    .from('connected_accounts')
    .upsert(
      {
        user_id: workspaceId,
        channel_type: 'whatsapp',
        channel_account_id: phoneNumberId,
        channel_account_name: displayName || verified_name || display_phone_number,
        channel_username: display_phone_number,
        access_token: accessToken,
        is_active: true,
        needs_reauth: false,
        metadata: { phone_number_id: phoneNumberId, verified_name, display_phone_number },
      },
      { onConflict: 'user_id,channel_type' }
    )

  if (upsertError) {
    return NextResponse.json({ error: upsertError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, displayPhone: display_phone_number })
}
