/**
 * GET  /api/founder/caye-direct/threads?workspaceId=<uuid>&q=<search>
 * POST /api/founder/caye-direct/threads   { workspaceId }
 *
 * Topic-thread history for Caye Direct (2026-08-13 redesign) — the
 * ChatGPT-style sidebar. Distinct from the operator-scoped
 * /api/founder/caye-direct route, which now backs the read-only operator-
 * observability overlay. See lib/caye-direct-threads.ts and
 * supabase/migrations/20260813_caye_direct_threads.sql for the model.
 *
 * GET lists threads for the sidebar (client buckets into Today/Yesterday/
 * Previous 7 days/Older). POST creates an empty thread ("+ New
 * conversation") — sending the first message happens against
 * /threads/:id, which is also where the title gets generated.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { requireFounder } from '@/lib/founder'
import { createThread, listThreads } from '@/lib/caye-direct-threads'

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const q = req.nextUrl.searchParams.get('q') ?? undefined
  const statusParam = req.nextUrl.searchParams.get('status')
  const status = statusParam === 'archived' ? 'archived' : 'active'

  const supabase = createServiceClient()
  try {
    const threads = await listThreads(supabase, workspaceId, { q, status })
    return NextResponse.json({ threads })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to list threads'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const workspaceId = body?.workspaceId as string | undefined
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const supabase = createServiceClient()
  try {
    const thread = await createThread(supabase, { workspaceId, createdBy: 'founder' })
    return NextResponse.json({ thread })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to create thread'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
