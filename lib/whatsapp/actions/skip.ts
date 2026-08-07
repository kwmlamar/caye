import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { type PendingHeldItem } from '../pending'
import type { ActionContext, ActionResult } from './types'
import { resolveOpenEscalations } from '@/lib/caye-agent/tools/write-low/resolve-open-escalations'
import { resolveItemRefOutcome, describeUnresolved } from '../item-ref-resolution'

export async function actionSkip(
  _ctx: ActionContext,
  intent: { item_ref?: string },
  pending: PendingHeldItem[]
): Promise<ActionResult> {
  const outcome = resolveItemRefOutcome(pending, intent.item_ref, (it) => it.conversationId)
  if (outcome.status !== 'matched') {
    return {
      ackBody: describeUnresolved(outcome, pending, {
        nothingPending: 'Nothing pending to skip.',
        question: 'Which one to skip?',
      }),
      tag: { label: 'skip', status: 'failed' },
    }
  }
  const item = outcome.item

  const supabase = createServiceClient()
  const { error } = await supabase
    .from('unified_conversations')
    .update({ human_agent_enabled: false, human_agent_reason: null })
    .eq('id', item.conversationId)

  if (error) {
    console.error('[action/skip] DB update failed:', error)
    return {
      ackBody: `Couldn't skip ${item.contactName} — ${error.message}.`,
      tag: { label: `skip ${item.contactName}`, status: 'failed' },
    }
  }

  // Also close out any open escalation row — otherwise it stays pending
  // forever and the "Needs review" stat card keeps counting a thread the
  // operator already skipped via WhatsApp.
  await resolveOpenEscalations(supabase, item.conversationId)

  return {
    ackBody: `Closed ${item.contactName}.`,
    tag: { label: `skip ${item.contactName}`, status: 'skipped' },
  }
}
