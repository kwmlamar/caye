import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

/**
 * Who owns the operator's next WhatsApp turn — the back-office agent, or the
 * legacy held-queue dispatch path.
 *
 * WHY THIS EXISTS (2026-08-07)
 * classifyOperatorIntent runs BEFORE and INDEPENDENTLY of the agent, and seven
 * intent kinds are hardcoded to the legacy path (LEGACY_DISPATCH_KINDS). That
 * made the agent's staged-confirmation protocol unreachable over WhatsApp:
 *
 *   Lamar:  "who was the last person to email me?"   → agent: Zanzibar Holidays One
 *   Lamar:  "draft a follow up for them"             → agent drafts
 *   Lamar:  "yea send that"                          → kind='send' → LEGACY
 *                                                      → "Which one? 1…19"
 *   Lamar:  "no to Zanzibar"                         → kind='unclear' → agent
 *                                                      → stages send to Zanzibar,
 *                                                        asks "Send that?"
 *   Lamar:  "Yes"                                    → kind='send' → LEGACY
 *                                                      → "No draft on file for
 *                                                         Oceans Africa."
 *
 * The agent staged the correct send to the correct recipient and was one "yes"
 * away from right. The confirmation was routed to a path that had never heard
 * of it — and the staged action sat in caye_pending_actions until it expired.
 *
 * Worse, the classifier is RIGHT to call that "Yes" a send: intent.ts tells it
 * a bare affirmative answering "Send that?" is a confirmation. So the better
 * the classifier follows its instructions, the more reliably it destroyed the
 * agent's confirmation. No amount of prompt tuning fixes that — the arbitration
 * itself is what's wrong.
 *
 * THE RULE: an open agent conversation owns the operator's reply. The legacy
 * path exists to answer held-queue PINGS ("Jeff came in — want me to take a
 * first pass?"), not to intercept turns mid-conversation with the agent.
 *
 * Ownership is decided from state, never from the classifier's label, so it
 * holds regardless of how the reply is worded.
 */

export type TurnOwner = 'agent' | 'legacy'

export interface TurnOwnership {
  owner: TurnOwner
  /** Short diagnostic for logs — why this turn was routed where it was. */
  reason: string
}

/**
 * True when a persisted caye_operator_messages row was written by the
 * back-office agent rather than by the legacy path or the outbound worker.
 *
 * The three writers are distinguishable by what they put in claude_format:
 *   - outbound-worker queue ping (logOperatorPing) → no claude_format at all
 *   - legacy ack (whatsapp-operator route)         → { content: "<string>" }
 *   - agent turn (persistAgentTurns)               → { content: [ …blocks ] }
 *
 * Only the agent persists a real Anthropic MessageParam, whose content is
 * always an array of blocks. That array is the signal.
 */
export function isAgentAuthored(claudeFormat: unknown): boolean {
  if (!claudeFormat || typeof claudeFormat !== 'object') return false
  return Array.isArray((claudeFormat as { content?: unknown }).content)
}

/**
 * Decide who handles this inbound.
 *
 * `lastOutboundClaudeFormat` is the claude_format of the most recent outbound
 * row to this operator — the caller already fetches that row for the intent
 * classifier, so it's passed in rather than re-queried.
 */
export async function resolveTurnOwner(args: {
  supabase: ReturnType<typeof createServiceClient>
  workspaceId: string
  operatorId: number | null
  lastOutboundClaudeFormat: unknown
}): Promise<TurnOwnership> {
  const { supabase, workspaceId, operatorId, lastOutboundClaudeFormat } = args

  // 1. An unexpired staged high-risk action means the agent explicitly asked a
  //    confirmation question and is waiting on the answer. Nothing else may
  //    claim that reply — this is the case that silently lost a correct send.
  //    Scoped to this operator exactly as gateHighRisk scopes its lookup, so
  //    one operator's pending confirmation can't capture another's turn.
  let staged = supabase
    .from('caye_pending_actions')
    .select('tool_name')
    .eq('workspace_id', workspaceId)
    .is('executed_at', null)
    .is('cancelled_at', null)
    .gt('expires_at', new Date().toISOString())
  staged = operatorId != null ? staged.eq('operator_id', operatorId) : staged.is('operator_id', null)

  const { data: pendingAction, error } = await staged
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    // Fail toward the legacy path's existing behaviour rather than guessing —
    // a lookup failure shouldn't silently change routing for every message.
    console.error('[turn-ownership] pending-action lookup failed:', error.message)
  } else if (pendingAction) {
    return {
      owner: 'agent',
      reason: `staged ${pendingAction.tool_name} awaiting confirmation`,
    }
  }

  // 2. No staged action, but if Caye's last word to this operator was an agent
  //    turn, the operator is mid-conversation with the agent. This is what
  //    "yea send that" needed: the agent had just drafted a follow-up in prose
  //    and asked "Want me to send that?", with nothing staged yet — and the
  //    referent (Zanzibar) lived in the agent's history, which the classifier
  //    never sees. It only gets the single most recent outbound body.
  if (isAgentAuthored(lastOutboundClaudeFormat)) {
    return { owner: 'agent', reason: 'last outbound was an agent turn' }
  }

  return { owner: 'legacy', reason: 'replying to a held-queue ping' }
}
