import 'server-only'
import { createServiceClient } from './supabase-server'
import { fetchStandingRulesOrThrow, findMatchingRule, buildStandingRuleEscalation, recordRuleFired } from './standing-rules'
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
 *
 * FAIL-CLOSED, deliberately, on both reads this function does (the
 * conversation-hold lookup and the standing-rules fetch): this is the
 * owner's actual authority gate, not an advisory check like
 * fetchStandingRules's other (escalate) callers. If we can't tell whether an
 * owner_only rule or an existing hold applies, the safe default is "don't
 * send autonomously" — an autonomous send that turns out to have skipped an
 * owner_only rule cannot be taken back, while a held message just waits an
 * extra beat for the owner. This is the opposite posture from
 * fetchStandingRules's own fail-open default; see that function's doc
 * comment for why the escalate path chooses differently.
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
  // says. Fails CLOSED on a read error: we cannot tell whether this
  // conversation is held, so autonomous outbound must not proceed on the
  // assumption that it isn't.
  const { data: convo, error: convoError } = await supabase
    .from('unified_conversations')
    .select('human_agent_enabled')
    .eq('id', params.conversationId)
    .maybeSingle()
  if (convoError) {
    console.error('[authorize-autonomous-outbound] conversation lookup failed, failing closed:', convoError.message)
    return { allowed: false, reason: 'blocked_by_authority_check_error' }
  }
  if (convo?.human_agent_enabled === true) {
    return { allowed: false, reason: 'blocked_by_existing_hold' }
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
