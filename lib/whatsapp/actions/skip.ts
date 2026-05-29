import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { resolveItemRef, type PendingHeldItem } from '../pending'
import type { ActionContext, ActionResult } from './types'

export async function actionSkip(
  _ctx: ActionContext,
  intent: { item_ref?: string },
  pending: PendingHeldItem[]
): Promise<ActionResult> {
  const item = resolveItemRef(pending, intent.item_ref)
  if (!item) {
    return {
      ackBody:
        pending.length === 0
          ? 'Nothing pending to skip.'
          : `Which one to skip? ${pending.map((p) => `${p.index}. ${p.contactName}`).join(' / ')}`,
      tag: { label: 'skip', status: 'failed' },
    }
  }

  const supabase = createServiceClient()
  await supabase
    .from('unified_conversations')
    .update({ human_agent_enabled: false, human_agent_reason: null })
    .eq('id', item.conversationId)

  return {
    ackBody: `Closed ${item.contactName}.`,
    tag: { label: `skip ${item.contactName}`, status: 'skipped' },
  }
}
