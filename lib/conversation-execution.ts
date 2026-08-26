import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { DispatchAmbiguousError } from '@/lib/whatsapp/channel-dispatch'

export type ExecutionHolder =
  | 'autonomous_frontdesk'
  | 'operator_caye'
  | 'human_manual'
  | 'scheduled_system'
  | 'correction_followup'

/**
 * Deterministic holder precedence (mirrors claim_conversation_execution's
 * SQL). Tier 2 (explicit human/operator direction) supersedes an active
 * tier 1 (autonomous/scheduled) claim outright; equal-tier claims never
 * steal from each other. Exported so callers/tests can reason about
 * authority without duplicating the tier table.
 */
export const EXECUTION_HOLDER_TIER: Record<ExecutionHolder, 1 | 2> = {
  human_manual: 2,
  operator_caye: 2,
  correction_followup: 2,
  autonomous_frontdesk: 1,
  scheduled_system: 1,
}

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

/**
 * Certain non-send: the caller knows for a fact its provider call was never
 * attempted, or was rejected before any external side effect (see
 * DispatchAmbiguousError's doc comment). Frees the inbound turn for a later
 * execution AND releases the claim, atomically.
 */
export async function abandonConversationExecutionResponse(claimId: string) {
  const supabase = createServiceClient()
  const { error } = await supabase.rpc('abandon_conversation_execution_response', { p_claim_id: claimId })
  if (error) throw new Error(`Could not abandon conversation execution response: ${error.message}`)
}

/**
 * Uncertain outcome: the caller cannot tell whether the provider accepted
 * the send. Marks the reservation so it stays permanently blocking — never
 * auto-retried, discoverable for manual reconciliation — and releases the
 * claim so the conversation itself isn't stuck even though this one inbound
 * turn is.
 */
export async function markConversationExecutionAmbiguous(claimId: string) {
  const supabase = createServiceClient()
  const { error } = await supabase.rpc('mark_conversation_execution_ambiguous', { p_claim_id: claimId })
  if (error) throw new Error(`Could not mark conversation execution ambiguous: ${error.message}`)
}

/**
 * The single place every claim-then-dispatch call site should route a
 * caught dispatch exception through. Classifies the failure so a retry is
 * only ever possible when we're certain nothing reached the customer:
 *
 * - DispatchAmbiguousError(definitelySent: true) — the provider accepted
 *   the message; only our own bookkeeping afterward failed. Complete the
 *   claim (as if the send had succeeded outright) so nothing can ever
 *   answer this turn again — never treat this as retryable.
 * - DispatchAmbiguousError(definitelySent: false) — the provider call
 *   itself threw; whether it was received is not knowable from here. Fail
 *   closed: mark ambiguous, never auto-retried.
 * - anything else — dispatchOperatorReply (and the equivalent inline
 *   dispatch in app/api/messages/send/route.ts) only ever throw a plain
 *   Error BEFORE attempting the provider call. Safe to abandon and retry.
 *
 * Best-effort: swallows its own RPC failures rather than compounding the
 * original error, since this always runs from inside a catch block.
 */
export async function resolveConversationExecutionAfterFailure(claimId: string, err: unknown): Promise<void> {
  if (err instanceof DispatchAmbiguousError) {
    if (err.definitelySent) {
      await completeConversationExecution(claimId).catch(() => undefined)
    } else {
      await markConversationExecutionAmbiguous(claimId).catch(() => undefined)
    }
    return
  }
  await abandonConversationExecutionResponse(claimId).catch(() => undefined)
}
