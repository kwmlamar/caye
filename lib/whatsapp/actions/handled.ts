import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { type PendingHeldItem } from '../pending'
import type { ActionContext, ActionResult } from './types'
import { resolveOpenEscalations } from '@/lib/caye-agent/tools/write-low/resolve-open-escalations'
import { resolveItemRefOutcome, describeUnresolved } from '../item-ref-resolution'

export async function actionHandled(
  _ctx: ActionContext,
  intent: { item_ref?: string },
  pending: PendingHeldItem[]
): Promise<ActionResult> {
  const outcome = resolveItemRefOutcome(pending, intent.item_ref, (it) => it.conversationId)
  if (outcome.status !== 'matched') {
    // A named ref that matches nothing gets said out loud — see
    // lib/whatsapp/item-ref-resolution.ts for the Lisa Ramos case.
    return {
      ackBody: describeUnresolved(outcome, pending, {
        nothingPending: "Nothing's on hold.",
        question: 'Which one did you handle?',
      }),
      tag: { label: 'handled', status: 'failed' },
    }
  }
  const item = outcome.item

  const supabase = createServiceClient()
  const { error } = await supabase
    .from('unified_conversations')
    .update({
      human_agent_enabled: false,
      human_agent_reason: 'operator handled directly',
    })
    .eq('id', item.conversationId)

  if (error) {
    console.error('[action/handled] DB update failed:', error)
    return {
      ackBody: `Couldn't mark ${item.contactName} as handled — ${error.message}.`,
      tag: { label: `handled ${item.contactName}`, status: 'failed' },
    }
  }

  // Also close out any open escalation row — otherwise it stays pending
  // forever and the "Needs review" stat card keeps counting a thread the
  // operator already disposed of via WhatsApp.
  await resolveOpenEscalations(supabase, item.conversationId)

  return {
    ackBody: `Got it — marked ${item.contactName} as handled.`,
    tag: { label: `handled ${item.contactName}`, status: 'ok' },
  }
}
