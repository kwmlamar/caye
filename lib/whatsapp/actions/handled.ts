import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { resolveItemRef, type PendingHeldItem } from '../pending'
import type { ActionContext, ActionResult } from './types'

export async function actionHandled(
  _ctx: ActionContext,
  intent: { item_ref?: string },
  pending: PendingHeldItem[]
): Promise<ActionResult> {
  const item = resolveItemRef(pending, intent.item_ref)
  if (!item) {
    return {
      ackBody:
        pending.length === 0
          ? "Nothing's on hold."
          : `Which one did you handle? ${pending.map((p) => `${p.index}. ${p.contactName}`).join(' / ')}`,
      tag: { label: 'handled', status: 'failed' },
    }
  }

  const supabase = createServiceClient()
  await supabase
    .from('unified_conversations')
    .update({
      human_agent_enabled: false,
      human_agent_reason: 'operator handled directly',
    })
    .eq('id', item.conversationId)

  return {
    ackBody: `Got it — marked ${item.contactName} as handled.`,
    tag: { label: `handled ${item.contactName}`, status: 'ok' },
  }
}
