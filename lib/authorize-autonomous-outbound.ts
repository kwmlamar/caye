import 'server-only'
import { createServiceClient } from './supabase-server'
import { fetchStandingRules, findMatchingRule, buildStandingRuleEscalation, recordRuleFired } from './standing-rules'
import type { ForcedEscalation } from './forced-escalation'

/**
 * The one shared choke point every autonomous customer-facing send must
 * clear before it executes (#88 — Jonathan Garcia / Full Bimini Experience).
 *
 * Two independent things can hard-block autonomous outbound on a
 * conversation, and this is the single place that resolves both:
 *   - an owner_only standing rule matching THIS message (see
 *     lib/standing-rules.ts) — never eligible for standdown;
 *   - a conversation already held for the owner
 *     (unified_conversations.human_agent_enabled) for any prior reason.
 *
 * Wired into lib/caye-agent/frontdesk-entry.ts so the check runs BEFORE the
 * model executes, not as a hope that it declines to call a send tool. Every
 * other autonomous send path (cron follow-ups, retries, other channels)
 * should route through this same function rather than reimplementing the
 * check — see the issue for the full inventory, most of which is later
 * slices.
 */

export type AutonomousOutboundBlockReason = 'blocked_by_owner_policy' | 'blocked_by_existing_hold'

export type AutonomousOutboundDecision =
  | { allowed: true }
  | {
      allowed: false
      reason: AutonomousOutboundBlockReason
      /** Present only for blocked_by_owner_policy — the escalation the
       *  caller should persist/surface to the owner. */
      escalation?: ForcedEscalation
    }

export async function authorizeAutonomousOutbound(params: {
  workspaceId: string
  conversationId: string
  inboundBody: string
}): Promise<AutonomousOutboundDecision> {
  const supabase = createServiceClient()

  // Existing hold first — cheapest check, and a hold from ANY prior reason
  // (a previous standing rule match, a low-confidence answer, a manual
  // owner takeover) must block regardless of what this specific message
  // says. Fails open on a read error, matching fetchStandingRules below:
  // losing this one check to a DB blip does not remove the owner_only gate.
  const { data: convo, error: convoError } = await supabase
    .from('unified_conversations')
    .select('human_agent_enabled')
    .eq('id', params.conversationId)
    .maybeSingle()
  if (convoError) {
    console.error('[authorize-autonomous-outbound] conversation lookup failed:', convoError.message)
  } else if (convo?.human_agent_enabled === true) {
    return { allowed: false, reason: 'blocked_by_existing_hold' }
  }

  const rules = await fetchStandingRules(params.workspaceId)
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
