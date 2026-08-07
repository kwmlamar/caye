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
import { holdKindOf, isAttentionHold } from '@/lib/hold-kinds'

const CONVERSATION_COLUMNS =
  'id, channel_type, customer_name, last_message_preview, last_message_at, human_agent_enabled, human_agent_reason, metadata'

interface ConversationRow {
  id: string
  channel_type: string
  customer_name: string | null
  last_message_preview: string | null
  last_message_at: string | null
  human_agent_enabled: boolean
  human_agent_reason: string | null
  metadata: unknown
}

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

  // Drafted cold outreach awaiting batch approval sets human_agent_enabled
  // just like a genuine hold, so a naive query here reproduces the exact
  // bug lib/hold-kinds.ts exists to fix — confirmed live 2026-08-07: this
  // route, unpatched, returns 19 for TropiTech Outreach's review count when
  // 18 of those are a queue nobody is waiting on (see the Phase 3 commit
  // for the agent-tool-side fix; this route is a separate codebase and
  // wasn't touched by it). isAttentionHold is applied in TS rather than as
  // a Postgrest jsonb-path filter — a queue-hold-heavy workspace still has
  // to fit inside REVIEW_SCAN_CAP for the exclusion to be exact, but
  // real review items are always small in practice (single digits across
  // every workspace seen to date) and this avoids trusting untested
  // Postgrest `->>`/`or`/null-handling syntax on a path that decides
  // whether the founder sees a complaint.
  const REVIEW_SCAN_CAP = 500

  let query = supabase
    .from('unified_conversations')
    .select(CONVERSATION_COLUMNS)
    .in('connected_account_id', connectedAccountIds)
    .eq('is_archived', false)
    .order('last_message_at', { ascending: false })
    .order('id', { ascending: false })

  if (filter === 'review') {
    query = query.eq('human_agent_enabled', true).limit(REVIEW_SCAN_CAP)
  } else {
    query = query.limit(limit + 1) // one extra row to know whether there's a next page
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
  // the current page or search result. Fetched + filtered in TS rather than
  // `count: 'exact', head: true` because a head-only count can't see
  // metadata.hold_kind and would recount the same queue-hold pollution
  // above.
  const [{ data: rows, error }, { data: heldRows, error: heldErr }] = await Promise.all([
    query,
    supabase
      .from('unified_conversations')
      .select('id, metadata')
      .in('connected_account_id', connectedAccountIds)
      .eq('is_archived', false)
      .eq('human_agent_enabled', true)
      .limit(REVIEW_SCAN_CAP),
  ])

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (heldErr) return NextResponse.json({ error: heldErr.message }, { status: 500 })

  const reviewCount = ((heldRows ?? []) as { metadata: unknown }[]).filter((r) =>
    isAttentionHold(holdKindOf(r.metadata))
  ).length

  const rawRows = (rows ?? []) as ConversationRow[]
  let page: ConversationRow[]
  let nextCursor: string | null

  if (filter === 'review') {
    const attentionRows = rawRows.filter((r) => isAttentionHold(holdKindOf(r.metadata)))
    page = attentionRows.slice(0, limit)
    // Cursor is anchored to the last RAW row scanned, not the last visible
    // one — a "load more" must resume past every row this fetch already
    // looked at (queue holds included), or it would re-scan and could
    // return the same page again. hasMore triggers on either genuinely
    // more attention items than fit on this page, or the raw scan filling
    // its cap (meaning rows beyond it were never even looked at).
    const lastRaw = rawRows[rawRows.length - 1]
    const hasMore = attentionRows.length > limit || rawRows.length === REVIEW_SCAN_CAP
    nextCursor = hasMore && lastRaw ? `${lastRaw.last_message_at}|${lastRaw.id}` : null
  } else {
    const hasMore = rawRows.length > limit
    page = rawRows.slice(0, limit)
    const last = page[page.length - 1]
    nextCursor = hasMore && last ? `${last.last_message_at}|${last.id}` : null
  }

  return NextResponse.json({ conversations: page, nextCursor, reviewCount })
}
