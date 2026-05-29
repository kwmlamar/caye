/**
 * POST /api/caye/operator-otp/send
 * Body: { phone: string }
 *
 * Generates a 6-digit code, stores it on workspace_ai_config.metadata with a
 * 10-minute TTL, and sends it to the operator via the caye_otp template.
 *
 * Auth: Supabase access token in Authorization: Bearer.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { sendTemplateWhatsApp } from '@/lib/whatsapp/outbound'

const OTP_TTL_MS = 10 * 60 * 1000

export async function POST(request: NextRequest) {
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServiceClient()
  const {
    data: { user },
  } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await safeJson(request)
  const phone = typeof body.phone === 'string' ? normalizePhone(body.phone) : ''
  if (!phone) return NextResponse.json({ error: 'Valid phone required' }, { status: 400 })

  // Resolve workspace. We assume the active workspace == the user's own customers row;
  // for the OTP flow we don't currently support setting an operator number for a
  // workspace the user only has membership in (admin would do that out-of-band).
  const workspaceId = user.id

  // Generate and persist the code on metadata.
  const code = String(Math.floor(100000 + Math.random() * 900000))
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString()

  const { data: cfg } = await supabase
    .from('workspace_ai_config')
    .select('metadata')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  const newMetadata = {
    ...((cfg?.metadata as Record<string, unknown>) ?? {}),
    operator_otp: { code, phone, expires_at: expiresAt },
  }

  // upsert in case the row doesn't yet exist
  await supabase
    .from('workspace_ai_config')
    .upsert({ workspace_id: workspaceId, metadata: newMetadata }, { onConflict: 'workspace_id' })

  // Send the template. Note: the OTP send uses Caye-platform creds (free of
  // 24h window concerns since otp is an authentication template).
  const result = await sendTemplateWhatsApp(phone, 'caye_otp', [code], `otp-${workspaceId}-${Date.now()}`)
  if (result.status === 'failed') {
    console.error(`[operator-otp/send] failed for ws ${workspaceId}: ${result.error}`)
    return NextResponse.json({ error: 'Failed to send code. Check the number and try again.' }, { status: 502 })
  }

  return NextResponse.json({ success: true })
}

async function safeJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 8) return ''
  return `+${digits}`
}
