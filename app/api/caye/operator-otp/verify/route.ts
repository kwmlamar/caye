/**
 * POST /api/caye/operator-otp/verify
 * Body: { code: string }
 *
 * Checks the pending code on workspace_ai_config.metadata.operator_otp. On
 * success: stores operator_whatsapp_number + operator_whatsapp_verified_at,
 * clears the otp metadata, and queues the welcome ping.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { enqueueOutbound } from '@/lib/whatsapp/outbound'

export async function POST(request: NextRequest) {
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServiceClient()
  const {
    data: { user },
  } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await safeJson(request)
  const code = typeof body.code === 'string' ? body.code.replace(/\D/g, '') : ''
  if (!code || code.length !== 6) {
    return NextResponse.json({ error: 'Enter the 6-digit code' }, { status: 400 })
  }

  const workspaceId = user.id

  const { data: cfg } = await supabase
    .from('workspace_ai_config')
    .select('metadata')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  const meta = (cfg?.metadata as Record<string, unknown>) ?? {}
  const otp = meta.operator_otp as
    | { code: string; phone: string; expires_at: string }
    | undefined

  if (!otp) {
    return NextResponse.json({ error: 'No code pending. Request a new one.' }, { status: 400 })
  }
  if (new Date(otp.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: 'Code expired. Request a new one.' }, { status: 400 })
  }
  if (otp.code !== code) {
    return NextResponse.json({ error: 'Code didn\'t match.' }, { status: 400 })
  }

  // Clear the pending otp from metadata; persist verification.
  const cleaned = { ...meta }
  delete (cleaned as Record<string, unknown>).operator_otp

  const now = new Date().toISOString()
  await supabase
    .from('workspace_ai_config')
    .update({
      operator_whatsapp_number: otp.phone,
      operator_whatsapp_verified_at: now,
      last_whatsapp_inbound_at: null, // explicit: window opens only on a real inbound
      whatsapp_unreachable: false,
      whatsapp_blocked: false,
      whatsapp_failure_streak: 0,
      metadata: cleaned,
    })
    .eq('workspace_id', workspaceId)

  // Queue the welcome ping (template — window not yet open).
  const { data: customer } = await supabase
    .from('customers')
    .select('full_name')
    .eq('id', workspaceId)
    .maybeSingle()
  const firstName = pickFirstName(customer?.full_name) ?? 'there'

  await enqueueOutbound({
    workspaceId,
    kind: 'welcome',
    payload: { firstName },
    scheduledFor: new Date(),
    idempotencyKey: `welcome-${workspaceId}-${now}`,
  })

  return NextResponse.json({ success: true })
}

async function safeJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

function pickFirstName(fullName: string | null | undefined): string | null {
  if (!fullName) return null
  const f = fullName.trim().split(/\s+/)[0]
  return f || null
}
