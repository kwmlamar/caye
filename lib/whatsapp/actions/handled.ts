import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { type PendingHeldItem } from '../pending'
import type { ActionContext, ActionResult } from './types'
import { resolveOpenEscalations } from '@/lib/caye-agent/tools/write-low/resolve-open-escalations'
import { resolveItemRefOutcome, describeUnresolved } from '../item-ref-resolution'

const MANUAL_OUTBOUND_EVIDENCE_WINDOW_MS = 60 * 60 * 1000

/**
 * A claim that the operator "handled it directly" is not completion evidence.
 * CAY-111: only close the held thread once a customer-visible outbound message
 * from a human/manual channel has actually appeared in the authoritative
 * conversation. This keeps "I'll send it" distinct from "it was sent".
 */
export async function hasRecentManualOutboundEvidence(
  supabase: ReturnType<typeof createServiceClient>,
  conversationId: string,
  now: Date = new Date()
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - MANUAL_OUTBOUND_EVIDENCE_WINDOW_MS).toISOString()
  const { data, error } = await supabase
    .from('unified_messages')
    .select('sent_at, metadata')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'business')
    .eq('is_internal', false)
    .gte('sent_at', cutoff)
    .order('sent_at', { ascending: false })
    .limit(20)

  if (error) {
    console.error('[action/handled] outbound evidence lookup failed:', error)
    return false
  }

  return (data ?? []).some((row) => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>
    return meta.sent_by === 'human' || meta.source === 'zoho_sent'
  })
}

export async function actionHandled(
  ctx: ActionContext,
  intent: { item_ref?: string },
  pending: PendingHeldItem[]
): Promise<ActionResult> {
  const outcome = resolveItemRefOutcome(pending, intent.item_ref, (it) => it.conversationId)
  if (outcome.status !== 'matched') {
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

  // Workspace ownership is re-established here rather than trusting the
  // pending list snapshot. A stale/cross-workspace id must never be enough to
  // clear a customer thread.
  const { data: owned } = await supabase
    .from('unified_conversations')
    .select('id, connected_account:connected_accounts!inner(user_id)')
    .eq('id', item.conversationId)
    .eq('connected_account.user_id', ctx.workspaceId)
    .maybeSingle()

  if (!owned) {
    return {
      ackBody: `I couldn't verify ${item.contactName}'s current thread, so I left it open.`,
      tag: { label: `handled ${item.contactName}`, status: 'failed' },
    }
  }

  const hasEvidence = await hasRecentManualOutboundEvidence(supabase, item.conversationId)
  if (!hasEvidence) {
    return {
      ackBody: `I haven't seen your outbound reply land on ${item.contactName}'s thread yet, so I left it open. Once it syncs, I can close it.`,
      tag: { label: `handled ${item.contactName}`, status: 'failed' },
    }
  }

  const { error } = await supabase
    .from('unified_conversations')
    .update({
      human_agent_enabled: false,
      human_agent_reason: 'operator handled directly — outbound verified',
    })
    .eq('id', item.conversationId)

  if (error) {
    console.error('[action/handled] DB update failed:', error)
    return {
      ackBody: `Couldn't mark ${item.contactName} as handled — ${error.message}.`,
      tag: { label: `handled ${item.contactName}`, status: 'failed' },
    }
  }

  await resolveOpenEscalations(supabase, item.conversationId)

  return {
    ackBody: `Got it — I can see your reply on ${item.contactName}'s thread, so I marked it handled.`,
    tag: { label: `handled ${item.contactName}`, status: 'ok' },
  }
}
