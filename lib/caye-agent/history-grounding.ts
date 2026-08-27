import type Anthropic from '@anthropic-ai/sdk'
import { enforceActionGrounding, type ExecutedToolOutcome } from './action-claim-guard'

/**
 * history-grounding.ts
 *
 * WHY THIS EXISTS (2026-08-16 stale-claim regression)
 * The action-grounding guard (action-claim-guard.ts) checks a reply against
 * what actually executed THIS turn before it's returned — that closed the
 * original incident (a fabricated "I sent it" with zero backing tool call)
 * for every turn generated AFTER the fix shipped. It did nothing for turns
 * already sitting in caye_operator_messages from BEFORE the fix existed.
 *
 * Three hours after the fix deployed, asked again to message Mrs. Max, Caye
 * replied "I already sent her that message 3 hours ago" — a claim about a
 * send that never happened. Traced: her sliding-window history (see
 * context.ts's loadOperatorContext, 24h/30-message window) still included
 * the ORIGINAL incident's uncorrected turn ("Here's what I sent her on
 * WhatsApp just now..."), timestamped ~3h19m earlier — well inside the
 * window. The model read its own past hallucination back as an established
 * fact and paraphrased it. Zero tool calls happened in the new turn, so
 * there was nothing for the live guard to check against — the CURRENT-turn
 * mechanism is not wrong, it just isn't the whole picture: a consequential
 * completion claim can enter a turn's context from HISTORY, not only from
 * that turn's own model output.
 *
 * THE FIX: apply the exact same grounding check to STORED history before it
 * is replayed into a new turn — using that PAST turn's own persisted
 * tool_use/tool_result rows as the evidence, not the (untrustworthy) prose
 * of the turn itself. This is "authoritative persisted execution evidence"
 * literally: the tool_use/tool_result blocks in claude_format ARE the
 * record of what actually ran; the assistant's own summary sentence is not.
 * Reuses enforceActionGrounding unchanged — a historical claim and a live
 * one are held to the identical rule set, so there is no second, weaker
 * "old claims" heuristic to drift out of sync with the first.
 *
 * Grouping caye_operator_messages rows into "loop invocations": a boundary
 * is any inbound row whose claude_format is NOT an array of tool_result
 * blocks (i.e. a real human/system message, not machinery responding to a
 * tool call) — this mirrors persistAgentTurns' own turn shape (one inbound
 * trigger row, N intermediate tool_use/tool_result rows, one final outbound
 * text row) without needing a new "turn id" column.
 */

export interface StoredTurnRow {
  direction: 'inbound' | 'outbound'
  body: string
  claude_format: Anthropic.MessageParam | null
  created_at: string | null
}

function contentIsToolResultTurn(content: Anthropic.MessageParam['content']): boolean {
  if (typeof content === 'string') return false
  return content.some((b) => (b as { type?: string }).type === 'tool_result')
}

/** True for an inbound row that starts a new loop invocation — a real human/system message, not a tool_result turn. */
function isLoopBoundary(row: StoredTurnRow): boolean {
  if (row.direction !== 'inbound') return false
  const cf = row.claude_format
  if (!cf) return true // legacy/unstructured row — nothing to group by, safest to treat as its own boundary
  return !contentIsToolResultTurn(cf.content)
}

/** Splits oldest-first rows into consecutive loop-invocation groups. */
export function groupIntoLoops(rowsOldestFirst: readonly StoredTurnRow[]): StoredTurnRow[][] {
  const groups: StoredTurnRow[][] = []
  let current: StoredTurnRow[] = []
  for (const row of rowsOldestFirst) {
    if (isLoopBoundary(row) && current.length > 0) {
      groups.push(current)
      current = []
    }
    current.push(row)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * Reconstructs what actually executed within one loop group by pairing each
 * assistant tool_use block with the tool_result block carrying the same
 * tool_use_id in the immediately following row — exactly the shape
 * execute.ts's own loop produces when it writes these rows in the first
 * place (one assistant tool_use turn, one user tool_result turn, repeat).
 */
export function extractExecutedToolsFromGroup(group: readonly StoredTurnRow[]): ExecutedToolOutcome[] {
  const executed: ExecutedToolOutcome[] = []

  for (let i = 0; i < group.length; i++) {
    const row = group[i]
    const cf = row.claude_format
    if (row.direction !== 'outbound' || !cf || typeof cf.content === 'string') continue

    const toolUses = cf.content.filter(
      (b): b is Anthropic.ToolUseBlock => (b as { type?: string }).type === 'tool_use'
    )
    if (toolUses.length === 0) continue

    const resultCf = group[i + 1]?.claude_format
    const resultBlocks =
      resultCf && typeof resultCf.content !== 'string'
        ? resultCf.content.filter(
            (b): b is Anthropic.ToolResultBlockParam => (b as { type?: string }).type === 'tool_result'
          )
        : []

    for (const toolUse of toolUses) {
      const match = resultBlocks.find((b) => b.tool_use_id === toolUse.id)
      let ok = false
      let pendingOnly = false
      if (match) {
        ok = match.is_error !== true
        const raw = typeof match.content === 'string' ? match.content : null
        let delivery: string | undefined
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as { ok?: boolean; data?: { executed?: boolean; delivery?: string } }
            if (typeof parsed.ok === 'boolean') ok = parsed.ok
            if (parsed.data?.executed === false) pendingOnly = true
            delivery = parsed.data?.delivery
          } catch {
            // Non-JSON tool_result content — fall back to is_error alone.
          }
        }
        // Mirrors execute.ts's live special case exactly: a stored
        // retrieve_artifact_for_operator success only grounds a "sent"
        // claim when it was a real external send, never an inline Caye
        // Direct rendering — see that file's comment.
        if (toolUse.name === 'retrieve_artifact_for_operator' && ok && delivery === 'whatsapp') {
          executed.push({ name: 'retrieve_artifact_for_operator:whatsapp', ok: true, pendingOnly: false })
        }
      }
      executed.push({ name: toolUse.name, ok, pendingOnly })
    }
  }

  return executed
}

/**
 * Re-validates a loop group's FINAL assistant text turn against tool
 * evidence reconstructed from that SAME group. Returns the group unchanged
 * when there's nothing to correct — a genuinely grounded historical claim
 * (a real send_operator_message success three hours ago) passes through
 * exactly as stored, satisfying "a real successful send remains recognizable
 * as completed" for historical claims, not just live ones.
 */
export function revalidateLoopGroup(group: readonly StoredTurnRow[]): StoredTurnRow[] {
  const lastRow = group[group.length - 1]
  const cf = lastRow?.claude_format
  if (!lastRow || lastRow.direction !== 'outbound' || !cf || typeof cf.content === 'string') {
    return [...group]
  }

  const textBlocks = cf.content.filter((b): b is Anthropic.TextBlock => (b as { type?: string }).type === 'text')
  if (textBlocks.length === 0) return [...group]

  const rawText = textBlocks.map((b) => b.text).join('\n')
  const executed = extractExecutedToolsFromGroup(group)
  const { text: corrected, violations } = enforceActionGrounding(rawText, executed)
  if (violations.length === 0) return [...group]

  const correctedRow: StoredTurnRow = {
    ...lastRow,
    body: corrected,
    claude_format: { role: 'assistant', content: [{ type: 'text', text: corrected }] },
  }
  return [...group.slice(0, -1), correctedRow]
}

/**
 * Re-validates every loop group in a full history window. Called by
 * loadOperatorContext / loadDirectThreadContext (context.ts) on the raw
 * rows BEFORE they're turned into the MessageParam[] handed to the model —
 * so a stale, uncorrected completion claim from before this fix existed (or
 * from any future gap) is corrected on the way IN to a new turn's context,
 * not just on the way out of the turn that first produced it. Idempotent:
 * re-running this against already-corrected history is a no-op (the
 * corrected text contains no completion claim to strip).
 */
export function revalidateHistory(rowsOldestFirst: readonly StoredTurnRow[]): StoredTurnRow[] {
  return groupIntoLoops(rowsOldestFirst).flatMap(revalidateLoopGroup)
}
