import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

export type ExecutionHolder =
  | 'autonomous_frontdesk'
  | 'operator_caye'
  | 'human_manual'
  | 'scheduled_system'
  | 'correction_followup'

export interface ConversationExecutionClaim {
  id: string
  generation: number
}

type ClaimResult =
  | { ok: true; claim: ConversationExecutionClaim }
  | { ok: false; blockedBy: string }

/** Durable, cross-process ownership for one customer-facing decision. */
export async function claimConversationExecution(args: {
  workspaceId: string
  conversationId: string
  holder: ExecutionHolder
  idempotencyKey: string
  triggeringMessageId?: string | null
  reason?: string | null
  leaseSeconds?: number
}): Promise<ClaimResult> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('claim_conversation_execution', {
    p_workspace_id: args.workspaceId,
    p_conversation_id: args.conversationId,
    p_holder_kind: args.holder,
    p_idempotency_key: args.idempotencyKey,
    p_triggering_message_id: args.triggeringMessageId ?? null,
    p_reason: args.reason ?? null,
    p_lease_seconds: args.leaseSeconds ?? 900,
  })
  if (error) throw new Error(`Could not claim conversation execution: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('Conversation execution claim returned no result')
  if (!row.acquired) return { ok: false, blockedBy: String(row.blocked_by ?? 'another_execution') }
  return { ok: true, claim: { id: String(row.claim_id), generation: Number(row.generation) } }
}

/** Last possible guard before a provider call. It reserves the inbound turn. */
export async function validateConversationExecution(args: {
  claimId: string
  triggeringMessageId?: string | null
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('validate_conversation_execution', {
    p_claim_id: args.claimId,
    p_triggering_message_id: args.triggeringMessageId ?? null,
  })
  if (error) throw new Error(`Could not validate conversation execution: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  return row?.valid ? { ok: true } : { ok: false, reason: String(row?.reason ?? 'validation_failed') }
}

export async function completeConversationExecution(claimId: string, outboundMessageId?: string | null) {
  const supabase = createServiceClient()
  const { error } = await supabase.rpc('complete_conversation_execution', {
    p_claim_id: claimId,
    p_outbound_message_id: outboundMessageId ?? null,
  })
  if (error) throw new Error(`Could not complete conversation execution: ${error.message}`)
}

export async function releaseConversationExecution(claimId: string) {
  const supabase = createServiceClient()
  const { error } = await supabase.rpc('release_conversation_execution', { p_claim_id: claimId })
  if (error) throw new Error(`Could not release conversation execution: ${error.message}`)
}
