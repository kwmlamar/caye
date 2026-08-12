import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import type { OperatorIdentity } from '@/lib/operator-identity'
import { deliveryFieldsFromResult, type SendResult } from '@/lib/whatsapp/outbound'
import { stripToolMarkers } from '@/lib/operator-text-guard'

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

/**
 * True when a persisted turn is INTERMEDIATE — part of the agent's tool
 * loop rather than the answer it produced — and so must not render as a
 * bubble in Caye Direct. Filters the human-facing GET; never skips the
 * insert, since claude_format replay and the audit trail want every turn.
 *
 * THE RULE: a turn that contains a tool call is not a final answer.
 *
 * Any text sharing a turn with a tool_use block is, by the shape of the
 * Anthropic API, spoken BEFORE the tool result exists — it is a preamble
 * ("Let me check both the held queue and pending quotes at the same
 * time."), never a conclusion. runToolLoop encodes the same fact: it
 * returns replyText only from a turn with zero tool_use blocks
 * (lib/caye-agent/execute.ts), and that is the one turn WhatsApp sends.
 * So the owner-facing transcript should show exactly what WhatsApp sent,
 * and nothing that preceded it.
 *
 * WHY THIS REPLACED MARKER-STRIPPING (2026-08-12). The 2026-08-07 fix hid
 * turns that were NOTHING BUT markers and stripped markers off the rest —
 * which un-leaked the "[tool_use: …]" token but left the narration it was
 * attached to. Mrs. Max's thread then showed "Let me check both the held
 * queue and pending quotes at the same time." as its own bubble above the
 * actual answer. Stripping the marker treated the symptom; the turn itself
 * was the thing that shouldn't be there.
 *
 * This is deliberately a property of the TURN, not a phrase list — it
 * holds for narration Caye hasn't invented yet, and needs no prompt
 * cooperation to work.
 */
export function isInternalTurnBody(body: string): boolean {
  if (body === '[empty]') return true
  if (TOOL_MARKER_PRESENT.test(body)) return true
  return stripToolMarkers(body).length === 0
}

/** Matches any marker summarizeTurnBody emits for a tool block. */
const TOOL_MARKER_PRESENT = /\[tool_use:|\[tool_result\]/

/**
 * The text of a persisted turn as a human should see it.
 *
 * Defence in depth behind isInternalTurnBody, which should already have
 * dropped every marker-bearing row. Kept so a future caller that renders
 * without filtering still can't put a raw marker on screen. The persisted
 * `body` column keeps its markers either way.
 */
export function visibleBody(body: string): string {
  return stripToolMarkers(body)
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
 *
 * notSentReason is for callers that deliberately chose NOT to attempt a
 * real send this turn (e.g. the scan crons skipping because the operator's
 * 24h window is closed) — distinct from the null case above, where there
 * was never any WhatsApp send to report on at all. Mutually exclusive with
 * finalSendResult; ignored if both are passed. Renders in Caye Direct as an
 * explicit "not sent" warning rather than no icon, and the reason string
 * becomes the tooltip. See 20260805_operator_messages_not_sent_status.sql.
 */
export async function persistAgentTurns(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  turns: Anthropic.MessageParam[],
  operator: OperatorIdentity | null,
  finalSendResult?: SendResult,
  notSentReason?: string
): Promise<void> {
  const lastAssistantIndex = turns.map((t) => t.role).lastIndexOf('assistant')
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    const direction = turn.role === 'assistant' ? 'outbound' : 'inbound'
    const isLastAssistant = i === lastAssistantIndex
    const delivery =
      finalSendResult && isLastAssistant
        ? deliveryFieldsFromResult(finalSendResult)
        : notSentReason && isLastAssistant
          ? { wa_message_id: null, wa_delivery_status: 'not_sent' as const, wa_delivery_error: notSentReason }
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
