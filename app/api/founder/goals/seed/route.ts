/**
 * POST /api/founder/goals/seed
 *
 * Founder-triggered, idempotent seed of the starter operator-scope
 * direction (see lib/goals/seed.ts). Never runs automatically — no
 * migration or cron calls this — so an empty install stays empty until a
 * founder deliberately clicks "Seed starter direction" in the Direction
 * page's empty state. Safe to call more than once: no-ops once an
 * operator-scope vision already exists.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS (lib/founder.ts).
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { seedStarterDirection } from '@/lib/goals/seed'

export async function POST(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const result = await seedStarterDirection(user.id)
  if (!result.created) return NextResponse.json({ created: false, reason: result.reason }, { status: 200 })
  return NextResponse.json({ created: true, visionId: result.visionId }, { status: 201 })
}
