import 'server-only'
import { createServiceClient } from './supabase-server'
import { fetchStandingRulesOrThrow, findMatchingRule, buildStandingRuleEscalation, recordRuleFired } from './standing-rules'
import type { ForcedEscalation } from './forced-escalation'

/**
 * The one shared choke point every autonomous customer-facing send must
 * clear before it executes (#88 — Jonathan Garcia / Full Bimini Experience).
 *
 * Two independent things can hard-block autonomous outbound on a
 * conversation:
 *   - an owner_only standing rule matching THIS message (see
 *     lib/standing-rules.ts) — never eligible for standdown;
 *   - a conversation hold that was created for THIS inbound turn (or a
 *     legacy hold whose creation time cannot be proven).
 *
 * A conversation-level human_agent_enabled flag is intentionally not treated
 * as a permanent takeover. A later customer message is a fresh turn and must
 * be allowed to reach the normal evidence/policy/send gates. Otherwise one
 * unresolved Friday policy question can freeze an unrelated Sunday logistics
 * question forever — the 2026-08-30 Autumn McNeill incident.
 *
 * Wired into lib/caye-agent/frontdesk-entry.ts so the check runs BEFORE the
 * model executes. The send boundary still independently validates current
 * policy, facts, booking state, stale overrides and execution ownership.
 *
 * FAIL-CLOSED, deliberately, on every authority read this function does. If
 * we cannot prove that a held conversation's newest customer turn is newer
 * than the hold, we preserve the hold rather than guessing.
 */

export type AutonomousOutboundBlockReason =
  | 'blocked_by_owner_policy'
  | 'blocked_by_existing_hold'
  | 'blocked_by_authority_check_error'

export type AutonomousOutboundDecision =
  | { allowed: true }
  | {
      allowed: false
      reason: AutonomousOutboundBlockReason
      /** Present only for blocked_by_owner_policy — the escalation the
       * caller should persist/surface to the owner. */
      escalation?: ForcedEscalation
    }

function isStrictlyNewer(iso: string | null | undefined, thanISO: string | null | undefined): boolean {
  if (!iso || !thanISO) return false
  const value = new Date(iso).getTime()
  const anchor = new Date(thanISO).getTime()
  return Number.isFinite(value) && Number.isFinite(anchor) && value > anchor
}

export async function authorizeAutonomousOutbound(params: {
  workspaceId: string
  conversationId: string
  inboundBody: string
}): Promise<AutonomousOutboundDecision> {
  const supabase = createServiceClient()

  // A hold blocks the turn that caused it, not the conversation for the rest
  // of time. The current inbound is already durably claimed/persisted before
  // this function runs, so the newest non-internal customer row is the exact
  // piece of evidence we need. If it is newer than human_agent_marked_at,
  // evaluate it fresh through the ordinary model + send boundary while the
  // older owner-attention item remains open independently.
  const { data: convo, error: convoError } = await supabase
    .from('unified_conversations')
    .select('human_agent_enabled, human_agent_marked_at')
    .eq('id', params.conversationId)
    .maybeSingle()
  if (convoError) {
    console.error('[authorize-autonomous-outbound] conversation lookup failed, failing closed:', convoError.message)
    return { allowed: false, reason: 'blocked_by_authority_check_error' }
  }
  if (convo?.human_agent_enabled === true) {
    // A missing/invalid hold timestamp is legacy/ambiguous authority state.
    // Do not silently reinterpret it as safe.
    if (!convo.human_agent_marked_at) {
      return { allowed: false, reason: 'blocked_by_existing_hold' }
    }

    const { data: latestInbound, error: inboundError } = await supabase
      .from('unified_messages')
      .select('sent_at')
      .eq('conversation_id', params.conversationId)
      .eq('sender_type', 'customer')
      .eq('is_internal', false)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (inboundError) {
      console.error('[authorize-autonomous-outbound] latest inbound lookup failed, failing closed:', inboundError.message)
      return { allowed: false, reason: 'blocked_by_authority_check_error' }
    }

    if (!isStrictlyNewer(latestInbound?.sent_at ?? null, convo.human_agent_marked_at)) {
      return { allowed: false, reason: 'blocked_by_existing_hold' }
    }
  }

  // Fails CLOSED on a read error too (fetchStandingRulesOrThrow, not
  // fetchStandingRules) — an unreadable rules table must not be
  // indistinguishable from "no owner_only rules configured".
  let rules
  try {
    rules = await fetchStandingRulesOrThrow(params.workspaceId)
  } catch (err) {
    console.error(
      '[authorize-autonomous-outbound] standing-rules lookup failed, failing closed:',
      err instanceof Error ? err.message : err
    )
    return { allowed: false, reason: 'blocked_by_authority_check_error' }
  }

  const matched = findMatchingRule(rules, params.inboundBody)
  if (matched && matched.action === 'owner_only') {
    recordRuleFired(matched.id)
    return {
      allowed: false,
      reason: 'blocked_by_owner_policy',
      escalation: buildStandingRuleEscalation(matched, params.inboundBody),
    }
  }

  return { allowed: true }
}
