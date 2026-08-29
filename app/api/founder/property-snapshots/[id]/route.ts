import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { getFounderPropertySnapshot } from '@/lib/property/store'
import { getFounderPropertyTelemetrySnapshot } from '@/lib/property/telemetry-snapshot'

/**
 * Resolve one canonical property after founder auth.
 * The property's own workspace is authoritative; the dashboard's currently
 * selected workspace must not break a rich result produced in another tenant.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await requireFounder(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const snapshot = await getFounderPropertySnapshot(id)
  if (!snapshot) return NextResponse.json({ error: 'Property not found' }, { status: 404 })

  const telemetry = await getFounderPropertyTelemetrySnapshot(id)
  return NextResponse.json({
    type: 'property_snapshot',
    snapshot: { ...snapshot, ...telemetry },
  })
}
