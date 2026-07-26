/**
 * GET /api/founder/coding-session/[id]
 *
 * Founder-only. Returns a coding session's current status plus its turn
 * history — what the panel polls while a `/code` session is active. Same
 * auth pattern as admin-shell/caye-direct.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { getCodingSession, getCodingSessionMessages } from '@/lib/coding-session/queries'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const session = await getCodingSession(id)
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const messages = await getCodingSessionMessages(id)
  return NextResponse.json({ session, messages })
}
