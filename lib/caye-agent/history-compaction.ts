import type Anthropic from '@anthropic-ai/sdk'

/**
 * history-compaction.ts
 *
 * Shrinks spent tool results before the conversation window is replayed.
 *
 * WHY (2026-08-11)
 * Measured over 7 days of production traffic, `tool_result` blocks were
 * **59.2% of every byte** stored in caye_operator_messages.claude_format —
 * 171 blocks averaging 2,441 bytes, the largest 25,378 bytes (a get_customer
 * contact dump). The sliding window replays them verbatim on every call, and
 * the messages array carries no cache breakpoint, so all of it is billed at
 * full uncached input price. That came to 6,479 uncached input tokens per
 * back-office call and $7.39 of a $15.12 weekly spend — the single largest
 * line item, larger than cache writes, cache reads and output combined.
 *
 * A tool result from eight turns ago has already done its job: the model read
 * it and wrote a reply, and that reply is still in the window verbatim. Paying
 * to re-send 25KB of JSON so the model can re-derive what it already said is
 * the waste here, not the tool call itself.
 *
 * WHAT IS PRESERVED, AND WHY IT MATTERS
 * Every valid block is kept, including its tool_use_id. The Anthropic API
 * requires each tool_use block to be answered by a tool_result carrying the
 * same id in the next turn. The sliding DB window can, however, cut across a
 * persisted tool exchange and leave an orphan result/use at either edge. We
 * repair those boundary fragments before compaction so replay is always a
 * structurally valid Anthropic conversation instead of a production 400.
 */

/**
 * Bytes of verbatim tool_result content kept, newest first.
 *
 * ~8KB ≈ 2,200 tokens. Generously covers the current turn plus several back,
 * which is the range a follow-up question ("what was that number?") can
 * actually reach — and past which the model's own prose reply, still in the
 * window untouched, is the better record anyway.
 */
export const VERBATIM_TOOL_RESULT_BUDGET_BYTES = 8000

/** What an elided result is replaced with. Valid JSON, so a model that reads
 *  it gets a shape it understands rather than a broken parse. */
const ELIDED = JSON.stringify({
  ok: true,
  note: 'Earlier result — details no longer shown. Re-run the tool if you need them again.',
})

type ContentBlock = Anthropic.MessageParam['content']

interface ToolUseBlock {
  type: 'tool_use'
  id: string
}

interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: unknown
  is_error?: boolean
}

function isToolUse(block: unknown): block is ToolUseBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'tool_use' &&
    typeof (block as { id?: unknown }).id === 'string'
  )
}

function isToolResult(block: unknown): block is ToolResultBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'tool_result' &&
    typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string'
  )
}

function blocksOf(message: Anthropic.MessageParam): unknown[] {
  return Array.isArray(message.content) ? message.content : []
}

/**
 * Remove only structurally impossible tool blocks created by a sliding-window
 * boundary or old bad persistence. Anthropic requires tool_result blocks to
 * answer tool_use blocks from the immediately preceding assistant message,
 * and every tool_use must receive a result in the immediately following user
 * message. Violating either rule rejects the whole request.
 *
 * Human text sharing the same message is preserved. If removing orphan tool
 * blocks empties a message entirely, that message is dropped.
 */
export function repairToolHistory(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (!Array.isArray(message.content)) {
      out.push(message)
      continue
    }

    const previous = out[out.length - 1]
    const previousUseIds = new Set(
      previous?.role === 'assistant'
        ? blocksOf(previous).filter(isToolUse).map((block) => block.id)
        : []
    )

    let blocks = message.content.filter((block) => {
      if (!isToolResult(block)) return true
      return message.role === 'user' && previousUseIds.has(block.tool_use_id)
    })

    if (message.role === 'assistant') {
      const next = messages[i + 1]
      const nextResultIds = new Set(
        next?.role === 'user'
          ? blocksOf(next).filter(isToolResult).map((block) => block.tool_use_id)
          : []
      )
      blocks = blocks.filter((block) => !isToolUse(block) || nextResultIds.has(block.id))
    }

    if (blocks.length === 0) continue
    out.push(blocks.length === message.content.length ? message : ({ ...message, content: blocks } as Anthropic.MessageParam))
  }

  return out
}

/**
 * Compact tool results beyond the verbatim budget.
 *
 * Takes messages oldest-first (the order handed to the API) and walks them
 * NEWEST-first internally, so the budget is spent on the most recent results.
 * Returns a new array; inputs are not mutated, because the caller may be
 * holding rows it also persists.
 */
export function compactHistory(
  messages: Anthropic.MessageParam[],
  budgetBytes: number = VERBATIM_TOOL_RESULT_BUDGET_BYTES
): Anthropic.MessageParam[] {
  const repaired = repairToolHistory(messages)
  let remaining = budgetBytes
  const out: Anthropic.MessageParam[] = new Array(repaired.length)

  for (let i = repaired.length - 1; i >= 0; i--) {
    const message = repaired[i]
    if (typeof message.content === 'string' || !Array.isArray(message.content)) {
      out[i] = message
      continue
    }

    let changed = false
    const blocks = message.content.map((block) => {
      if (!isToolResult(block)) return block

      const size = contentSize(block.content)
      if (size <= remaining) {
        remaining -= size
        return block
      }
      // Out of budget. Keep the block and its id; shrink only the payload.
      if (size <= ELIDED.length) {
        remaining = Math.max(0, remaining - size)
        return block
      }
      changed = true
      return { ...block, content: ELIDED }
    })

    out[i] = changed ? ({ ...message, content: blocks } as Anthropic.MessageParam) : message
  }

  return out
}

function contentSize(content: unknown): number {
  if (content === undefined || content === null) return 0
  if (typeof content === 'string') return content.length
  try {
    return JSON.stringify(content).length
  } catch {
    return 0
  }
}

/** Total bytes of tool_result content in a window. For tests and logging. */
export function toolResultBytes(messages: Anthropic.MessageParam[]): number {
  let total = 0
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (isToolResult(block)) total += contentSize(block.content)
    }
  }
  return total
}

export type { ContentBlock }
