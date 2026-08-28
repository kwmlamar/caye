/**
 * GET  /api/founder/caye-direct/threads?q=<search>
 * POST /api/founder/caye-direct/threads   { workspaceId }
 *
 * Founder Direct history is founder-scoped. GET returns conversations across
 * workspaces by default. POST still requires an initial workspace because
 * every actual Caye turn must execute against one concrete tenant.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { requireFounder } from '@/lib/founder'
import { createThread, listThreads } from '@/lib/caye-direct-threads'

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const q = req.nextUrl.searchParams.get('q') ?? undefined
  const statusParam = req.nextUrl.searchParams.get('status')
  const status = statusParam === 'archived' ? 'archived' : 'active'

  const supabase = createServiceClient()
  try {
    // Deliberately ignore the legacy workspaceId query parameter. Existing
    // dashboard clients may still send it, but chat ownership is founder-
    // scoped now. A future explicit workspace filter should use a distinct
    // parameter instead of accidentally restoring tenant-owned threads.
    const threads = await listThreads(supabase, null, { q, status })
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
