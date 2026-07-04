/**
 * GET /api/founder/contacts?workspaceId=<uuid>
 *
 * Contacts for a single workspace, for the founder rail's "Contacts" tab.
 * Same auth shape as /api/founder/global-performance: Bearer JWT, founder
 * check, then verify the requester is actually a member of the requested
 * workspace before returning data. Read-only.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user || !isFounderUserId(user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) {
    return NextResponse.json({ error: 'Missing workspaceId' }, { status: 400 })
  }

  const supabase = createServiceClient()

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: contacts, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('customer_id', workspaceId)
    .order('last_message_at', { ascending: false, nullsFirst: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ contacts: contacts ?? [] })
}
