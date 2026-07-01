import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { normalizeE164, tryAutoProvisionOwner } from '@/lib/onboarding-whatsapp'

/**
 * POST /api/onboarding/register-phone
 *
 * Called from the /onboarding handoff screen before the WhatsApp deep
 * link is revealed. Pre-registers the owner's phone as a verified entry
 * in operator_allowlist so the wa.me prefilled message can stay clean
 * (no visible tracking code) — Caye recognizes the number the moment it
 * messages her, via the normal allowlist lookup.
 *
 * Body: { workspaceId: string, phone: string }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

  const { workspaceId, phone } = body as { workspaceId?: string; phone?: string }
  if (!workspaceId || !phone) {
    return NextResponse.json({ error: 'workspaceId and phone are required' }, { status: 400 })
  }

  const normalized = normalizeE164(phone)
  if (normalized.length < 8) {
    return NextResponse.json({ error: 'That phone number looks incomplete' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const provisioned = await tryAutoProvisionOwner(supabase, workspaceId, normalized)

  if (!provisioned) {
    return NextResponse.json(
      { error: 'Could not register this workspace — it may already be set up.' },
      { status: 409 }
    )
  }

  return NextResponse.json({ success: true })
}
