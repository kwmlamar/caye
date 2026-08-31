import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase-server'
import type { OperatorIdentity } from '@/lib/operator-identity'
import { deliveryFieldsFromResult, type SendResult } from '@/lib/whatsapp/outbound'
import { stripToolMarkers } from '@/lib/operator-text-guard'
import { humanizeLegacyAttentionText } from '@/lib/attention-presentation'
import type { RichResult } from './caye-direct-rich-results'

export function summarizeTurnBody(turn: Anthropic.MessageParam): string {
  if (typeof turn.content === 'string') return turn.content
  const parts: string[] = []
  for (const block of turn.content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool_use') parts.push(`[tool_use: ${block.name}]`)
    else if (block.type === 'tool_result') parts.push('[tool_result]')
  }
  return parts.join(' ').trim() || '[empty]'
}

const TOOL_MARKER_PRESENT = /\[tool_use:|\[tool_result\]|\[internal_only\]/

export function isInternalTurnBody(body: string): boolean {
  if (body === '[empty]') return true
  if (TOOL_MARKER_PRESENT.test(body)) return true
  return stripToolMarkers(body).length === 0
}

/**
 * Canonical human render boundary for stored operator turns. Audit storage is
 * untouched; only the text shown to a human is repaired. This closes the
 * historical `Skipped held thread <uuid>` leak without deleting provenance.
 */
export function visibleBody(body: string): string {
  return humanizeLegacyAttentionText(stripToolMarkers(body))
}

export function dedupeConsecutive<T extends { direction: string; body: string }>(rows: T[]): T[] {
  const out: T[] = []
  for (const row of rows) {
    const prev = out[out.length - 1]
    if (prev && prev.direction === row.direction && prev.body === row.body) continue
    out.push(row)
  }
  return out
}

export async function persistAgentTurns(
  supabase: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  turns: Anthropic.MessageParam[],
  operator: OperatorIdentity | null,
  finalSendResult?: SendResult,
  notSentReason?: string,
  origin: 'whatsapp' | 'dashboard' = 'whatsapp',
  finalTurnVisibility: 'visible' | 'internal' = 'visible',
  richResult?: RichResult
): Promise<{ id: string }[]> {
  const lastAssistantIndex = turns.map((t) => t.role).lastIndexOf('assistant')
  const inserted: { id: string }[] = []
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
    const body =
      isLastAssistant && finalTurnVisibility === 'internal' ? '[internal_only]' : summarizeTurnBody(turn)
    const { data, error } = await supabase
      .from('caye_operator_messages')
      .insert({
        workspace_id: workspaceId,
        direction,
        ...delivery,
        body,
        intent: null,
        claude_format: turn,
        operator_allowlist_id: operator?.id ?? null,
        operator_name: operator?.name ?? null,
        operator_role: operator?.role ?? null,
        origin,
        rich_result: isLastAssistant ? (richResult ?? null) : null,
      })
      .select('id')
      .single()
    if (!error && data) inserted.push({ id: data.id as string })
  }
  return inserted
}
