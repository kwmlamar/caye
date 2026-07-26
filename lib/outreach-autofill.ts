import 'server-only'
import { createServiceClient } from './supabase-server'

/**
 * Strip a stale outreach_followup/outreach_first_touch autofill draft off a
 * conversation before a NEW, unrelated hold/escalation marks it
 * human_agent_enabled again.
 *
 * CommandConversations.tsx auto-fills the founder's compose box from
 * unified_conversations.metadata.proposed_reply whenever human_agent_enabled
 * is true and metadata.hold_kind is one of the two repeatable outreach
 * templates (safe to autofill because they're policy-constrained copy, not
 * a judgment call). Neither the zoho-email webhook's hold branch nor
 * recordEscalation() touch conversation metadata when THEY set
 * human_agent_enabled, so a hold_kind/proposed_reply left over from an
 * earlier outreach-nudge-scan run keeps satisfying that check forever —
 * the compose box silently autofills with the old templated nudge instead
 * of staying empty (the documented behavior for a general hold) or getting
 * a fresh "Draft with Caye" draft.
 *
 * Confirmed live 2026-07-26: Michael Frank (Frankie Tours, Tobago) replied
 * to cold outreach asking what Caye offers. Caye correctly held with an
 * "Interested — asking what Caye/TropiTech offers" note, but the compose
 * box still showed a leftover "just floating this back up" follow-up nudge
 * drafted against the same lead before he ever replied.
 */
export async function clearStaleOutreachAutofill(conversationId: string): Promise<void> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('unified_conversations')
    .select('metadata')
    .eq('id', conversationId)
    .maybeSingle()

  const metadata = (data?.metadata ?? {}) as Record<string, unknown>
  if (metadata.hold_kind !== 'outreach_followup' && metadata.hold_kind !== 'outreach_first_touch') {
    return
  }

  const { hold_kind: _staleHoldKind, proposed_reply: _staleProposedReply, ...rest } = metadata
  await supabase.from('unified_conversations').update({ metadata: rest }).eq('id', conversationId)
}
