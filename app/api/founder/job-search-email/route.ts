import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { buildConnectUrl } from '@/lib/channels/connect-token'
import { createServiceClient } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const supabase = createServiceClient()
  const { data: account } = await supabase.from('founder_connected_accounts')
    .select('id,email_address,is_active,needs_reauth,last_polled_at,updated_at')
    .eq('founder_user_id', user.id).eq('provider', 'zoho').eq('is_active', true).maybeSingle()
  return NextResponse.json({
    account: account ?? null,
    connectUrl: buildConnectUrl(user.id, 'zoho', { source: 'job-search' }),
  })
}

export async function DELETE(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const supabase = createServiceClient()
  const { error } = await supabase.from('founder_connected_accounts')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('founder_user_id', user.id).eq('provider', 'zoho')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
