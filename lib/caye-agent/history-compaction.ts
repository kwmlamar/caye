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
 * Every block is kept, including its tool_use_id. The Anthropic API requires
 * each tool_use block to be answered by a tool_result carrying the same id in
 * the next turn; dropping or reordering blocks produces a 400, not a saving.
 * Only the `content` of an out-of-budget tool_result is replaced.
 *
 * tool_use inputs are left alone. They are 17.4% of bytes against
 * tool_result's 59.2%, and they record what the model asked for — rewriting
 * those is a worse trade for a third of the benefit.
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
  let remaining = budgetBytes
  const out: Anthropic.MessageParam[] = new Array(messages.length)

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
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

interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: unknown
  is_error?: boolean
}

function isToolResult(block: unknown): block is ToolResultBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'tool_result'
  )
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
