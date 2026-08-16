import 'server-only'
import type Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'

const UNIQUE_VIOLATION = '23505'

export interface FrontDeskAgentTurnRow {
  id: string
  role: 'user' | 'assistant'
  claude_format: Anthropic.MessageParam
  created_at: string
}

/**
 * Persists every turn produced during one front-desk agent invocation,
 * keyed to the customer (inbound) message that triggered it. Idempotent
 * under retry: sequence is assigned in-order for this invocation, so a
 * webhook/provider retry that re-runs the same invocation for the same
 * triggeringMessageId hits the DB's unique constraint on
 * (conversation_id, triggering_message_id, sequence) — caught and treated
 * as "already persisted," not surfaced as an error. See
 * supabase/migrations/20260816_caye_frontdesk_agent_turns.sql.
 *
 * A fast pre-check (count for this trigger) avoids the round-trip cost of
 * re-inserting on the common case; the unique constraint is what actually
 * guarantees no duplicate rows, not the pre-check (which has its own small
 * race window, same class of gap already accepted elsewhere in this
 * codebase — see rescheduleBookingFromCaye's read-then-update in
 * lib/caye-reply.ts).
 *
 * NOT wired into any production webhook — see lib/caye-agent/context.ts's
 * loadFrontDeskConversationContext for the read side and the Phase 3
 * report for why this stays unwired this phase.
 */
export async function persistFrontDeskAgentTurns(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  conversationId: string,
  triggeringMessageId: string | null,
  turns: Anthropic.MessageParam[]
): Promise<{ persisted: number; alreadyPersisted: boolean }> {
  if (turns.length === 0) return { persisted: 0, alreadyPersisted: false }

  if (triggeringMessageId) {
    const { count } = await supabase
      .from('caye_frontdesk_agent_turns')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .eq('triggering_message_id', triggeringMessageId)
    if (count && count > 0) return { persisted: 0, alreadyPersisted: true }
  }

  let persisted = 0
  for (let sequence = 0; sequence < turns.length; sequence++) {
    const turn = turns[sequence]
    const { error } = await supabase.from('caye_frontdesk_agent_turns').insert({
      workspace_id: workspaceId,
      conversation_id: conversationId,
      triggering_message_id: triggeringMessageId,
      sequence,
      role: turn.role,
      claude_format: turn,
    })
    if (error) {
      if (error.code === UNIQUE_VIOLATION) continue
      throw error
    }
    persisted++
  }
  return { persisted, alreadyPersisted: false }
}

/**
 * Batch-loads persisted agent turns for a set of triggering (customer)
 * message ids in one conversation, grouped and ordered by sequence — the
 * shape loadFrontDeskConversationContext needs to splice richer tool-loop
 * history in place of the flattened unified_messages reconstruction
 * wherever it exists.
 */
export async function loadAgentTurnsForTriggers(
  supabase: ReturnType<typeof createServiceClient>,
  conversationId: string,
  triggeringMessageIds: string[]
): Promise<Map<string, FrontDeskAgentTurnRow[]>> {
  const out = new Map<string, FrontDeskAgentTurnRow[]>()
  if (triggeringMessageIds.length === 0) return out

  const { data, error } = await supabase
    .from('caye_frontdesk_agent_turns')
    .select('id, triggering_message_id, role, claude_format, created_at, sequence')
    .eq('conversation_id', conversationId)
    .in('triggering_message_id', triggeringMessageIds)
    .order('sequence', { ascending: true })

  if (error || !data) {
    console.warn('[caye-frontdesk-agent-turns] load failed:', error?.message)
    return out
  }

  for (const row of data) {
    const key = row.triggering_message_id as string
    const list = out.get(key) ?? []
    list.push({
      id: row.id as string,
      role: row.role as 'user' | 'assistant',
      claude_format: row.claude_format as Anthropic.MessageParam,
      created_at: row.created_at as string,
    })
    out.set(key, list)
  }
  return out
}
