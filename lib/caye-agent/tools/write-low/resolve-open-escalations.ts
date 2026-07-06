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
  await supabase
    .from('caye_escalations')
    .update({ owner_responded_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .is('owner_responded_at', null)
}
