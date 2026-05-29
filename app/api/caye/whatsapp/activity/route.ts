/**
 * GET /api/caye/whatsapp/activity?conversation_id=<uuid>
 *
 * Without conversation_id: returns the last 50 outbound queue rows for the
 * workspace — diagnostic view for the settings panel.
 *
 * With conversation_id: returns just the entries for that conversation —
 * powers the "Caye also pinged you on WhatsApp X ago" indicator in
 * ChatsScreen.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

export async function GET(request: NextRequest) {
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServiceClient()
  const {
    data: { user },
  } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = user.id
  const convId = request.nextUrl.searchParams.get('conversation_id')

  let query = supabase
    .from('caye_outbound_queue')
    .select('id, kind, status, scheduled_for, sent_at, created_at, last_error, conversation_id, payload')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(50)

  if (convId) query = query.eq('conversation_id', convId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ rows: data ?? [] })
}
