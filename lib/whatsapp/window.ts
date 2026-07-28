import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

/**
 * Meta's customer service window is 24h from the recipient's last inbound.
 * We use a 23h cutoff to leave a 1h safety margin against clock skew /
 * in-flight processing.
 */
const WINDOW_MS = 23 * 60 * 60 * 1000

/**
 * Returns true if THIS specific recipient phone has messaged Caye recently
 * enough that a free-form text will land, per Meta's per-recipient 24h
 * window. Otherwise the caller must use an approved template.
 *
 * Deliberately per-phone, not per-workspace: a workspace can have multiple
 * operators (owner, staff, founder), and Meta enforces the window against
 * each recipient number individually. Checking a workspace-wide flag let
 * one operator messaging Caye "open the window" for every operator on that
 * workspace, including ones who hadn't messaged in days — a free-form send
 * to that stale operator then gets rejected by Meta with 131047. Confirmed
 * live 2026-07-27: Bimini's morning_digest to Mrs. Max took the free-form
 * path because Lamar (founder, different phone, same workspace) had
 * messaged recently. See briefs/whatsapp-delivery-reliability.md.
 *
 * Fails closed: no allowlist row, or a null/missing last_inbound_at, both
 * return false → template path. A wrongly-closed window costs nothing (the
 * template still sends); a wrongly-open one is a hard delivery failure.
 */
export async function isWhatsAppWindowOpen(workspaceId: string, phone: string): Promise<boolean> {
  const supabase = createServiceClient()
  const normalized = phone.replace(/^\+/, '')
  const { data, error } = await supabase
    .from('operator_allowlist')
    .select('last_inbound_at')
    .eq('workspace_id', workspaceId)
    .or(`phone.eq.${normalized},phone.eq.+${normalized}`)
    .maybeSingle()

  if (error) {
    console.error('[isWhatsAppWindowOpen] lookup failed:', error)
    return false
  }
  const last = data?.last_inbound_at
  if (!last) return false
  return Date.now() - new Date(last).getTime() < WINDOW_MS
}
