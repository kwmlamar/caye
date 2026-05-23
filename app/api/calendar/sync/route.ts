/**
 * POST /api/calendar/sync
 *
 * Pushes a booking change to the workspace's external calendar (currently Zoho).
 * Called by BookingModal after every save / cancel.
 *
 * Body: { booking_id: string, action: 'upsert' | 'delete' }
 *
 * Thin wrapper around lib/calendar-sync.ts — the same helper is used directly
 * by the channel webhook handlers when Caye creates a booking from chat.
 *
 * Returns 200 with { synced: false, reason } on failure so the caller's
 * booking save isn't rolled back.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { syncBookingToCalendar } from '@/lib/calendar-sync'

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return NextResponse.json({ error: 'Missing auth token' }, { status: 401 })

  const supabase = createServiceClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { booking_id?: string; action?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { booking_id, action } = body
  if (!booking_id || (action !== 'upsert' && action !== 'delete')) {
    return NextResponse.json(
      { error: 'booking_id and action (upsert|delete) required' },
      { status: 400 }
    )
  }

  const result = await syncBookingToCalendar(user.id, booking_id, action)
  return NextResponse.json(result)
}
