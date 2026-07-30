/**
 * GET /api/founder/conversations?workspaceId=<uuid>&filter=all|review&q=&cursor=&limit=
 *
 * Founder-only, paginated + searchable front-desk conversation list.
 * Replaces the flat top-N conversations that used to live inline in
 * /api/founder/command-overview — that cap silently hid older held
 * conversations from the Review tab and made the search box search only
 * whatever page happened to already be loaded (2026-07-30).
 *
 * Keyset-paginated on (last_message_at desc, id desc) rather than
 * offset — matches idx_unified_conversations_account and stays correct
 * as new messages reorder the list between page fetches.
 *
 * `id` param bypasses filter/q/cursor entirely to fetch one conversation
 * by id (scoped to the workspace) — used when a sibling panel (e.g. a
 * booking click-through) needs to jump to a conversation that isn't in
 * whatever page is currently loaded.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'

const CONVERSATION_COLUMNS =
  'id, channel_type, customer_name, last_message_preview, last_message_at, human_agent_enabled, human_agent_reason, metadata'

// Escapes ilike wildcards so a customer name containing "%" or "_"
// searches literally instead of as a pattern.
function escapeIlike(value: string): string {
  return value.replace(/[%_]/g, (c) => `\\${c}`)
}

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

  const connectedAccountIds = await supabase
    .from('connected_accounts')
    .select('id')
    .eq('user_id', workspaceId)
    .then((r) => (r.data ?? []).map((a) => a.id))

  if (!connectedAccountIds.length) {
    return NextResponse.json({ conversations: [], nextCursor: null, reviewCount: 0 })
  }

  // Single-conversation lookup for a sibling panel jumping to a
  // conversation outside whatever page is currently loaded.
  const id = req.nextUrl.searchParams.get('id')
  if (id) {
    const { data, error } = await supabase
      .from('unified_conversations')
      .select(CONVERSATION_COLUMNS)
      .eq('id', id)
      .in('connected_account_id', connectedAccountIds)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ conversation: data ?? null })
  }

  const filter = req.nextUrl.searchParams.get('filter') === 'review' ? 'review' : 'all'
  const q = req.nextUrl.searchParams.get('q')?.trim() ?? ''
  const cursor = req.nextUrl.searchParams.get('cursor')
  const limitParam = parseInt(req.nextUrl.searchParams.get('limit') ?? '', 10)
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 30

  let query = supabase
    .from('unified_conversations')
    .select(CONVERSATION_COLUMNS)
    .in('connected_account_id', connectedAccountIds)
    .eq('is_archived', false)
    .order('last_message_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1) // one extra row to know whether there's a next page

  if (filter === 'review') {
    query = query.eq('human_agent_enabled', true)
  }
  if (q) {
    query = query.ilike('customer_name', `%${escapeIlike(q)}%`)
  }
  if (cursor) {
    const [ts, cursorId] = cursor.split('|')
    if (ts && cursorId) {
      query = query.or(`last_message_at.lt.${ts},and(last_message_at.eq.${ts},id.lt.${cursorId})`)
    }
  }

  // Review count ignores q/cursor — it's the tab's total, not a count of
  // the current page or search result.
  const [{ data: rows, error }, { count: reviewCount, error: reviewCountErr }] = await Promise.all([
    query,
    supabase
      .from('unified_conversations')
      .select('id', { count: 'exact', head: true })
      .in('connected_account_id', connectedAccountIds)
      .eq('is_archived', false)
      .eq('human_agent_enabled', true),
  ])

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (reviewCountErr) return NextResponse.json({ error: reviewCountErr.message }, { status: 500 })

  const hasMore = (rows ?? []).length > limit
  const page = (rows ?? []).slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor = hasMore && last ? `${last.last_message_at}|${last.id}` : null

  return NextResponse.json({ conversations: page, nextCursor, reviewCount: reviewCount ?? 0 })
}
