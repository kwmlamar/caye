import 'server-only'
import { dispatchOperatorReply } from '../channel-dispatch'
import { resolveItemRef, type PendingHeldItem } from '../pending'
import type { ActionContext, ActionResult } from './types'
import { claimConversationExecution, completeConversationExecution, releaseConversationExecution, resolveConversationExecutionAfterFailure, validateConversationExecution } from '@/lib/conversation-execution'

export async function actionSend(
  ctx: ActionContext,
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

  const execution = await claimConversationExecution({
    workspaceId: ctx.workspaceId,
    conversationId: item.conversationId,
    holder: 'operator_caye',
    idempotencyKey: `whatsapp-approve:${item.conversationId}:${Date.now()}`,
    reason: 'operator approved held item via WhatsApp',
  })
  if (!execution.ok) {
    return {
      ackBody: `This conversation is currently being handled by ${execution.blockedBy} — reload before sending to ${item.contactName}.`,
      tag: { label: `send ${item.contactName}`, status: 'failed' },
    }
  }
  const validated = await validateConversationExecution({ claimId: execution.claim.id })
  if (!validated.ok) {
    await releaseConversationExecution(execution.claim.id)
    return {
      ackBody: `Conversation changed before this could be sent (${validated.reason}) — reload before sending to ${item.contactName}.`,
      tag: { label: `send ${item.contactName}`, status: 'failed' },
    }
  }

  // Set the instant dispatchOperatorReply returns successfully — guards the
  // catch below so a failure completing the coordinator record afterward is
  // never mistaken for "nothing was sent."
  let dispatched = false
  try {
    await dispatchOperatorReply(item.conversationId, item.proposedReply)
    dispatched = true
    await completeConversationExecution(execution.claim.id).catch((completeErr) => {
      console.error('[actions/send] dispatch succeeded but completing the execution claim failed (safe — left unresolved rather than freed for retry):', completeErr)
    })
    return {
      ackBody: `Done. Sent to ${item.contactName}.`,
      tag: { label: `send ${item.contactName}`, status: 'ok' },
    }
  } catch (err) {
    if (!dispatched) await resolveConversationExecutionAfterFailure(execution.claim.id, err)
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[actions/send] dispatch failed:', msg)
    return {
      ackBody: `Couldn't send to ${item.contactName} — ${msg.slice(0, 100)}. Open the dashboard.`,
      tag: { label: `send ${item.contactName}`, status: 'failed' },
    }
  }
}
