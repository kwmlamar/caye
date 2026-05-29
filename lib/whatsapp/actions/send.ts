import 'server-only'
import { dispatchOperatorReply } from '../channel-dispatch'
import { resolveItemRef, type PendingHeldItem } from '../pending'
import type { ActionContext, ActionResult } from './types'

export async function actionSend(
  _ctx: ActionContext,
  intent: { item_ref?: string },
  pending: PendingHeldItem[]
): Promise<ActionResult> {
  const item = resolveItemRef(pending, intent.item_ref)
  if (!item) {
    return {
      ackBody:
        pending.length === 0
          ? "Nothing pending to send."
          : `Which one? ${pending.map((p) => `${p.index}. ${p.contactName}`).join(' / ')}`,
      tag: { label: 'send', status: 'failed' },
    }
  }
  if (!item.proposedReply) {
    return {
      ackBody: `No draft on file for ${item.contactName}. Tell me what to say.`,
      tag: { label: `send ${item.contactName}`, status: 'failed' },
    }
  }

  try {
    await dispatchOperatorReply(item.conversationId, item.proposedReply)
    return {
      ackBody: `Done. Sent to ${item.contactName}.`,
      tag: { label: `send ${item.contactName}`, status: 'ok' },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[actions/send] dispatch failed:', msg)
    return {
      ackBody: `Couldn't send to ${item.contactName} — ${msg.slice(0, 100)}. Open the dashboard.`,
      tag: { label: `send ${item.contactName}`, status: 'failed' },
    }
  }
}
