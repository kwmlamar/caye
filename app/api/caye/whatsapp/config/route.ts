/**
 * GET  /api/caye/whatsapp/config — current operator WhatsApp state for the active workspace
 * PATCH /api/caye/whatsapp/config — update mute / quiet hours
 *
 * Read returns everything the settings panel + dashboard banner need in one
 * round-trip. Write is restricted to mute_until + quiet-hours fields; phone
 * changes go through the OTP flow (see operator-otp/*).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'

interface WhatsAppConfigPayload {
  operatorNumber: string | null
  verifiedAt: string | null
  quietStart: string
  quietEnd: string
  mutedUntil: string | null
  unreachable: boolean
  blocked: boolean
  failureStreak: number
  lastOutboundStatus: string | null
  lastInboundAt: string | null
  outboundEnabled: boolean
}

async function authedWorkspace(request: NextRequest): Promise<string | null> {
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  const supabase = createServiceClient()
  const {
    data: { user },
  } = await supabase.auth.getUser(token)
  return user?.id ?? null
}

export async function GET(request: NextRequest) {
  const workspaceId = await authedWorkspace(request)
  if (!workspaceId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServiceClient()
  const { data } = await supabase
    .from('workspace_ai_config')
    .select(
      `
      operator_whatsapp_number, operator_whatsapp_verified_at,
      whatsapp_quiet_hours_start, whatsapp_quiet_hours_end,
      whatsapp_muted_until, whatsapp_unreachable, whatsapp_blocked,
      whatsapp_failure_streak, last_whatsapp_outbound_status,
      last_whatsapp_inbound_at, whatsapp_outbound_enabled
    `
    )
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  const payload: WhatsAppConfigPayload = {
    operatorNumber: data?.operator_whatsapp_number ?? null,
    verifiedAt: data?.operator_whatsapp_verified_at ?? null,
    quietStart: data?.whatsapp_quiet_hours_start ?? '21:00',
    quietEnd: data?.whatsapp_quiet_hours_end ?? '07:00',
    mutedUntil: data?.whatsapp_muted_until ?? null,
    unreachable: Boolean(data?.whatsapp_unreachable),
    blocked: Boolean(data?.whatsapp_blocked),
    failureStreak: data?.whatsapp_failure_streak ?? 0,
    lastOutboundStatus: data?.last_whatsapp_outbound_status ?? null,
    lastInboundAt: data?.last_whatsapp_inbound_at ?? null,
    outboundEnabled: Boolean(data?.whatsapp_outbound_enabled),
  }
  return NextResponse.json(payload)
}

export async function PATCH(request: NextRequest) {
  const workspaceId = await authedWorkspace(request)
  if (!workspaceId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await safeJson(request)
  const patch: Record<string, unknown> = {}

  if (body.mutedUntil === null) patch.whatsapp_muted_until = null
  else if (typeof body.mutedUntil === 'string') {
    const d = new Date(body.mutedUntil)
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: 'Invalid mutedUntil' }, { status: 400 })
    }
    patch.whatsapp_muted_until = d.toISOString()
  }
  // Clear unreachable/blocked when the operator explicitly retries.
  if (body.clearUnreachable === true) {
    patch.whatsapp_unreachable = false
    patch.whatsapp_failure_streak = 0
  }
  if (body.clearBlocked === true) patch.whatsapp_blocked = false

  if (typeof body.quietStart === 'string' && /^\d{2}:\d{2}$/.test(body.quietStart)) {
    patch.whatsapp_quiet_hours_start = body.quietStart
  }
  if (typeof body.quietEnd === 'string' && /^\d{2}:\d{2}$/.test(body.quietEnd)) {
    patch.whatsapp_quiet_hours_end = body.quietEnd
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from('workspace_ai_config')
    .update(patch)
    .eq('workspace_id', workspaceId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}

async function safeJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    return await request.json()
  } catch {
    return {}
  }
}
