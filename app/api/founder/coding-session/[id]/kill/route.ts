/**
 * POST /api/founder/coding-session/[id]/kill
 *
 * Founder-only. Marks a session for teardown — actual sandbox kill/stop
 * happens on the next cron poll tick (lib/coding-session/poll.ts), so this
 * route stays trivially fast.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { requestKillCodingSession } from '@/lib/coding-session/kill'
import { getCodingSession } from '@/lib/coding-session/queries'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const session = await getCodingSession(id)
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await requestKillCodingSession(id)
  return NextResponse.json({ ok: true })
}
