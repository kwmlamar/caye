/**
 * GET /api/founder/memory?workspaceId=<uuid>
 *
 * Read-only view over what Caye actually knows about this business —
 * business_facts (advisory knowledge: policies, service details, special
 * handling, logistics) and caye_standing_rules (enforced constraints,
 * evaluated deterministically before the model runs). See
 * supabase/migrations/20260625_business_facts.sql and
 * 20260808_caye_standing_rules.sql for the knowledge/enforcement split.
 *
 * No write path here on purpose, matching ContactsPanel's convention: this
 * is a lens on what Caye already learned via add_business_fact / standing
 * rule creation in chat, not an editor. Teaching Caye something new stays
 * a WhatsApp action.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  }

  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user || !isFounderUserId(user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const supabase = createServiceClient()

  const [{ data: facts, error: factsErr }, { data: rules, error: rulesErr }] = await Promise.all([
    supabase
      .from('business_facts')
      .select('id, category, fact, source, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('caye_standing_rules')
      .select('id, trigger_type, match_value, action, route_to, is_active, times_fired, last_fired_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(100),
  ])

  if (factsErr) return NextResponse.json({ error: factsErr.message }, { status: 500 })
  if (rulesErr) return NextResponse.json({ error: rulesErr.message }, { status: 500 })

  return NextResponse.json({ facts: facts ?? [], rules: rules ?? [] })
}
