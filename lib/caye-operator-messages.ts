import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import type { OperatorIdentity } from '@/lib/operator-identity'
import { deliveryFieldsFromResult, type SendResult } from '@/lib/whatsapp/outbound'

/**
 * Render a one-line body summary for a Claude MessageParam — used for
 * the audit-friendly `body` column on caye_operator_messages. Real
 * Claude shape lives in `claude_format`. Shared by the whatsapp-operator
 * webhook and the web-based Caye Direct route so both persist agent
 * turns identically.
 */
export function summarizeTurnBody(turn: Anthropic.MessageParam): string {
  if (typeof turn.content === 'string') return turn.content
  const parts: string[] = []
  for (const block of turn.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool_use') parts.push(`[tool_use: ${block.name}]`)
    else if (block.type === 'tool_result') parts.push(`[tool_result]`)
  }
  return parts.join(' ').trim() || '[empty]'
}

const TOOL_MARKER_RE = /\[tool_use: [^\]]+\]|\[tool_result\]/g

/**
 * A turn whose body is nothing but tool_use/tool_result markers (see
 * summarizeTurnBody above) — real for the agent's own history replay via
 * claude_format, but internal scratch that a human reading Caye Direct
 * shouldn't see as a raw "[tool_use: get_customer_history]" bubble. Used
 * to filter the human-facing GET response, not to skip persisting the row.
 */
export function isInternalOnlyBody(body: string): boolean {
  if (body === '[empty]') return true
  return body.replace(TOOL_MARKER_RE, '').trim().length === 0
}

/**
 * Persists every turn produced during a cayeAgent tool loop so the next
 * sliding-window load reconstructs the full Claude history. direction
 * maps from the MessageParam role: assistant→outbound, user→inbound.
 *
 * finalSendResult is the outcome of the ONE real WhatsApp send this turn
 * loop produced — the final assistant text turn, sent by the caller right
 * before persisting (see whatsapp-operator/route.ts and its image-inbound
 * handler). Every other turn (intermediate tool_use/tool_result turns, and
 * the whole array when called from the web-based Caye Direct route, which
 * never sends over WhatsApp at all) has nothing to report and stays null.
 * Applied to the LAST assistant-role turn specifically, not just the last
 * array element, since a turn loop's trailing entries are always
 * assistant-authored but this is more robust to that shifting.
 */
export async function persistAgentTurns(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  turns: Anthropic.MessageParam[],
  operator: OperatorIdentity | null,
  finalSendResult?: SendResult
): Promise<void> {
  const lastAssistantIndex = turns.map((t) => t.role).lastIndexOf('assistant')
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    const direction = turn.role === 'assistant' ? 'outbound' : 'inbound'
    const delivery =
      finalSendResult && i === lastAssistantIndex
        ? deliveryFieldsFromResult(finalSendResult)
        : { wa_message_id: null, wa_delivery_status: null, wa_delivery_error: null }
    await supabase.from('caye_operator_messages').insert({
      workspace_id: workspaceId,
      direction,
      ...delivery,
      body: summarizeTurnBody(turn),
      intent: null,
      claude_format: turn,
      operator_allowlist_id: operator?.id ?? null,
      operator_name: operator?.name ?? null,
      operator_role: operator?.role ?? null,
    })
  }
}
