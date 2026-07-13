/**
 * PATCH /api/founder/caye-toggle
 *
 * Founder-only pause/resume for a workspace's Caye deployment — backs the
 * Deployment stat card's toggle button on FounderHome. Writes
 * whatsapp_muted_until, the same field the back-office mute_caye/unmute_caye
 * chat tools write (lib/caye-agent/tools/write-low/{mute,unmute}-caye.ts),
 * so a founder flipping this switch and an operator muting Caye over
 * WhatsApp stay consistent with each other and with the reply pipeline's
 * own gate (see command-overview's mute-gate comment).
 *
 * Deliberately does NOT touch workspace_ai_config.ai_enabled: verified
 * directly against production (2026-07-12) that the column doesn't exist
 * there (its migration was never applied), so writing it errors the whole
 * update. Pause is modeled as an indefinite mute (INDEFINITE_MUTE_UNTIL)
 * rather than a separate switch, since whatsapp_muted_until is the one
 * field confirmed to actually gate replies in production today.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS — not exposed to
 * workspace owners.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'

// Stands in for "paused until manually resumed" on a column that's a
// timestamp, not a boolean. Far enough out to never lapse on its own;
// unmute (or the Resume click, which clears the field to null) is the
// only way off it.
const INDEFINITE_MUTE_UNTIL = '2099-01-01T00:00:00.000Z'

export async function PATCH(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user || !isFounderUserId(user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const { workspaceId, active } = body as { workspaceId?: string; active?: boolean }
  if (!workspaceId || typeof active !== 'boolean') {
    return NextResponse.json({ error: 'workspaceId and active (boolean) are required' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const patch = { whatsapp_muted_until: active ? null : INDEFINITE_MUTE_UNTIL }

  const { error } = await supabase
    .from('workspace_ai_config')
    .update(patch)
    .eq('workspace_id', workspaceId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, caye_active: active })
}
