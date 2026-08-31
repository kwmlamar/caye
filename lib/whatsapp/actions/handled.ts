import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { type PendingHeldItem } from '../pending'
import type { ActionContext, ActionResult } from './types'
import { resolveOpenEscalations } from '@/lib/caye-agent/tools/write-low/resolve-open-escalations'
import { resolveItemRefOutcome, describeUnresolved } from '../item-ref-resolution'

const MANUAL_OUTBOUND_EVIDENCE_WINDOW_MS = 60 * 60 * 1000

/**
 * Transport evidence is useful for reconciliation, but it is NOT the authority
 * that decides whether an owner-reported completion counts. A verified owner
 * saying "I dealt with it" closes the owner-attention/hold state immediately.
 * Missing outbound sync is recorded separately as an effect-verification
 * anomaly so a lagging provider mirror can never veto the human decision.
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
    return meta.sent_by === 'human' || meta.source === 'zoho_sent' || meta.operator_approved === true
  })
}

async function recordMissingOutboundSync(
  supabase: ReturnType<typeof createServiceClient>,
  args: { workspaceId: string; conversationId: string; attentionId?: string | null; contactName: string }
): Promise<void> {
  const now = new Date().toISOString()
  const identity = args.attentionId ?? args.conversationId
  const effectId = `manual-reply-sync:${identity}`
  const idempotencyKey = `manual-reply-sync:${identity}`
  const { error } = await supabase.from('caye_effect_verifications').upsert(
    {
      workspace_id: args.workspaceId,
      effect_id: effectId,
      effect: 'customer_reply_delivery_sync',
      action_kind: 'operator_handled',
      authority_ref: args.attentionId ? `attention:${args.attentionId}` : `conversation:${args.conversationId}`,
      idempotency_key: idempotencyKey,
      intended_effect: {
        conversation_id: args.conversationId,
        attention_id: args.attentionId ?? null,
        contact_name: args.contactName,
        source: 'verified_operator_completion_statement',
      },
      expected_state: { recent_manual_outbound_present: true },
      requested_at: now,
      attempted_at: now,
      execution_status: 'indeterminate',
      execution_receipt: {},
      observation_source: 'unified_messages',
      observed_state: { recent_manual_outbound_present: false },
      observed_at: now,
      verification_status: 'INDETERMINATE',
      verification_confidence: 0,
      comparison: [
        {
          field: 'recent_manual_outbound_present',
          expected: true,
          observed: false,
        },
      ],
      verification_reason:
        'Verified operator marked the work handled, but the expected customer-facing outbound has not appeared in the unified message mirror yet.',
      ambiguity_reason: 'delivery_sync_anomaly',
      retry_safe: false,
      recovery_state: 'observe_only',
      updated_at: now,
    },
    { onConflict: 'workspace_id,idempotency_key' }
  )
  if (error) console.error('[action/handled] delivery-sync anomaly record failed:', error)
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

  // Resolve the durable attention identity BEFORE mutating anything. The
  // customer name is only a UI fallback; once the pending conversation is
  // matched, this exact attention row is the lifecycle authority.
  const { data: attention, error: attentionError } = await supabase
    .from('caye_owner_attention')
    .select('id, state_fingerprint, status')
    .eq('workspace_id', ctx.workspaceId)
    .eq('conversation_id', item.conversationId)
    .in('status', ['open', 'acknowledged', 'decided'])
    .order('last_changed_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (attentionError) {
    console.error('[action/handled] attention lookup failed:', attentionError)
    return {
      ackBody: `Couldn't verify ${item.contactName}'s current attention item, so I left it open.`,
      tag: { label: `handled ${item.contactName}`, status: 'failed' },
    }
  }

  // Decision state first. The authenticated operator's completion statement is
  // authoritative and idempotent. Transport reconciliation runs only after the
  // attention/hold lifecycle has already moved to completed.
  const completedAt = new Date().toISOString()
  const { error } = await supabase
    .from('unified_conversations')
    .update({
      human_agent_enabled: false,
      human_agent_reason: 'operator handled directly',
      human_agent_marked_at: null,
    })
    .eq('id', item.conversationId)

  if (error) {
    console.error('[action/handled] DB update failed:', error)
    return {
      ackBody: `Couldn't mark ${item.contactName} as handled — ${error.message}.`,
      tag: { label: `handled ${item.contactName}`, status: 'failed' },
    }
  }

  if (attention) {
    const { error: attentionUpdateError } = await supabase
      .from('caye_owner_attention')
      .update({
        status: 'resolved',
        acknowledged_at: completedAt,
        completed_at: completedAt,
        blocked_on_operator: false,
        operator_aware_at: completedAt,
        operator_aware_fingerprint: attention.state_fingerprint,
        operator_aware_summary: 'Verified operator reported this item handled directly.',
        next_action: null,
        last_changed_at: completedAt,
        updated_at: completedAt,
      })
      .eq('id', attention.id)
      .eq('workspace_id', ctx.workspaceId)
      .in('status', ['open', 'acknowledged', 'decided'])
    if (attentionUpdateError) {
      console.error('[action/handled] attention completion failed:', attentionUpdateError)
      return {
        ackBody: `I cleared the thread hold, but couldn't complete ${item.contactName}'s attention item — ${attentionUpdateError.message}.`,
        tag: { label: `handled ${item.contactName}`, status: 'failed' },
      }
    }
  }

  // Preserve an immutable audit trail independent of provider sync.
  const { error: eventError } = await supabase.from('workspace_events').insert({
    workspace_id: ctx.workspaceId,
    occurred_at: completedAt,
    type: 'attention.completed_by_operator',
    actor_kind: 'operator',
    is_failure: false,
    subject_table: attention ? 'caye_owner_attention' : 'unified_conversations',
    subject_id: attention?.id ?? item.conversationId,
    conversation_id: item.conversationId,
    payload: {
      source: 'operator_handled_intent',
      item_ref: intent.item_ref ?? null,
      attention_id: attention?.id ?? null,
      conversation_id: item.conversationId,
      contact_name: item.contactName,
      decision: 'handled',
    },
    origin: 'app',
  })
  if (eventError) console.error('[action/handled] audit event failed:', eventError)

  await resolveOpenEscalations(supabase, item.conversationId)

  const hasEvidence = await hasRecentManualOutboundEvidence(supabase, item.conversationId)
  if (!hasEvidence) {
    await recordMissingOutboundSync(supabase, {
      workspaceId: ctx.workspaceId,
      conversationId: item.conversationId,
      attentionId: attention?.id ?? null,
      contactName: item.contactName,
    })
  }

  return {
    ackBody: `Got it — I marked ${item.contactName} as handled by you.`,
    tag: { label: `handled ${item.contactName}`, status: 'ok' },
  }
}
