import type { createServiceClient } from '@/lib/supabase-server'

/**
 * Close out any still-open caye_escalations rows tied to a conversation
 * when the operator disposes of it (mark_handled / skip_held_item / a
 * direct reply from any channel) rather than by sending an actual
 * customer-facing reply through the agent. Without this, the escalation
 * row stays pending forever — human_agent_enabled flips back to false (so
 * it drops off the Review tab) but the "Needs review" stat card keeps
 * counting a thread nobody can act on anymore.
 *
 * Deliberately kept free of the `server-only` guard used in `_guards.ts`
 * — it's imported from lib/data/mobile.ts, which is bundled into a client
 * component, and `server-only` would break that build.
 */
export async function resolveOpenEscalations(
  supabase: ReturnType<typeof createServiceClient>,
  conversationId: string
): Promise<void> {
  const now = new Date().toISOString()
  await supabase
    .from('caye_escalations')
    .update({ owner_responded_at: now })
    .eq('conversation_id', conversationId)
    .is('owner_responded_at', null)

  // Drop the item out of the shared attention ledger at the same instant
  // (2026-08-12). This is the one chokepoint every disposal route already
  // funnels through — mark_handled, skip_held_item, send_reply, and the
  // mobile inbox — so resolving here means a handled thread stops being
  // briefed about no matter which surface handled it.
  //
  // Inlined rather than calling lib/owner-attention.ts's
  // resolveAttentionForConversation because this module is deliberately
  // free of the `server-only` guard (see the note above — lib/data/mobile.ts
  // bundles it into a client component) and that module is not. Same table,
  // same statuses, same semantics; keep the two in step.
  await supabase
    .from('caye_owner_attention')
    .update({ status: 'resolved', completed_at: now, last_changed_at: now, updated_at: now })
    .eq('conversation_id', conversationId)
    .in('status', ['open', 'acknowledged', 'decided'])
}
