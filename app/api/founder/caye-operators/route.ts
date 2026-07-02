/**
 * GET /api/founder/caye-operators?workspaceId=<uuid>
 *
 * Read-only list of operator_allowlist rows for a workspace — powers the
 * operator switcher in Caye Direct so the founder can see each operator's
 * (owner, staff, founder) back-office conversation with Caye separately.
 * No add/edit/remove here — team membership changes are a Caye-chat
 * action (the add_team_member tool), per the dashboard's locked scope in
 * Products/Caye/CLAUDE.md. This is purely a lens on data that already
 * exists, same as Command Conversations is a lens on unified_conversations.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user || !isFounderUserId(user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('operator_allowlist')
    .select('id, name, role')
    .eq('workspace_id', workspaceId)
    .order('role', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ operators: data ?? [] })
}
