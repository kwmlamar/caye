import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { readDirectionOutcomes } from '@/lib/direction/outcome-read-model'

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const outcomes = await readDirectionOutcomes()
    return NextResponse.json(outcomes, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  } catch (error) {
    console.error('[direction-outcomes] Could not compute canonical outcomes', error)
    return NextResponse.json({ error: 'Direction outcomes unavailable' }, { status: 503 })
  }
}
