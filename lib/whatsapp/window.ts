import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

/**
 * Meta's customer service window is 24h from the recipient's last inbound.
 * We use a 23h cutoff to leave a 1h safety margin against clock skew /
 * in-flight processing.
 */
const WINDOW_MS = 23 * 60 * 60 * 1000

/**
 * Returns true if the operator has messaged Caye recently enough that we can
 * send a free-form text. Otherwise the caller must use an approved template.
 */
export async function isWhatsAppWindowOpen(workspaceId: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('workspace_ai_config')
    .select('last_whatsapp_inbound_at')
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (error) {
    console.error('[isWhatsAppWindowOpen] lookup failed:', error)
    return false
  }
  const last = data?.last_whatsapp_inbound_at
  if (!last) return false
  return Date.now() - new Date(last).getTime() < WINDOW_MS
}
