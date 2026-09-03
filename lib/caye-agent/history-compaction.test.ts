import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { compactHistory, toolResultBytes } from './history-compaction'

function toolUse(id: string, name = 'get_customer'): Anthropic.MessageParam {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { q: 1 } }] }
}
function toolResult(id: string, size: number): Anthropic.MessageParam {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(size) }],
  }
}
function text(role: 'user' | 'assistant', body: string): Anthropic.MessageParam {
  return { role, content: body }
}

describe('compactHistory — API contract', () => {
  it('keeps every tool_result block and its id', () => {
    // The API answers a tool_use with a matching tool_result id. Dropping a
    // block is a 400, not a saving.
    const history = [toolUse('a'), toolResult('a', 20000), toolUse('b'), toolResult('b', 20000)]
    const out = compactHistory(history, 100)

    const ids = out.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((b) => b.type === 'tool_result').map((b) => (b as { tool_use_id: string }).tool_use_id)
        : []
    )
    expect(ids).toEqual(['a', 'b'])
    expect(out).toHaveLength(history.length)
  })

  it('leaves an elided result as parseable JSON', () => {
    const out = compactHistory([toolUse('a'), toolResult('a', 20000)], 0)
    const block = (out[1].content as { content: string }[])[0]
    expect(() => JSON.parse(block.content)).not.toThrow()
  })

  it('does not mutate the input', () => {
    const history = [toolUse('a'), toolResult('a', 20000)]
    const before = JSON.stringify(history)
    compactHistory(history, 0)
    expect(JSON.stringify(history)).toBe(before)
  })

  it('passes plain-text turns through untouched', () => {
    const history = [text('user', 'yes please'), text('assistant', 'Done.')]
    expect(compactHistory(history, 0)).toEqual(history)
  })
})

describe('compactHistory — budget behaviour', () => {
  it('spends the budget on the newest results, not the oldest', () => {
    // A follow-up question can only reach recent results; the oldest are the
    // ones the model has already summarised into prose.
    const history = [
      toolUse('old'), toolResult('old', 5000),
      toolUse('new'), toolResult('new', 5000),
    ]
    const out = compactHistory(history, 6000)

    const oldBlock = (out[1].content as { content: string }[])[0]
    const newBlock = (out[3].content as { content: string }[])[0]
    expect(newBlock.content).toHaveLength(5000) // newest kept verbatim
    expect(oldBlock.content.length).toBeLessThan(500) // oldest elided
  })

  it('keeps everything when the window fits in budget', () => {
    const history = [toolUse('a'), toolResult('a', 500), toolUse('b'), toolResult('b', 500)]
    expect(compactHistory(history, 8000)).toEqual(history)
  })

  it('never grows a result that is already smaller than the placeholder', () => {
    // Replacing `{"ok":true}` with a longer "omitted" note would cost tokens
    // to save tokens.
    const history = [toolUse('a'), toolResult('a', 5)]
    const out = compactHistory(history, 0)
    expect((out[1].content as { content: string }[])[0].content).toBe('xxxxx')
  })

  it('bounds total tool_result bytes regardless of window size', () => {
    const history: Anthropic.MessageParam[] = []
    for (let i = 0; i < 30; i++) {
      history.push(toolUse(`t${i}`), toolResult(`t${i}`, 25000))
    }
    expect(toolResultBytes(history)).toBe(750_000)

    const out = compactHistory(history, 8000)
    // 8KB of verbatim payload plus one short placeholder per elided block.
    expect(toolResultBytes(out)).toBeLessThan(8000 + 30 * 200)
  })

  it('reproduces the measured production saving', () => {
    // Real 7-day shape: tool_results 59.2% of bytes, avg 2,441, max 25,378.
    const history: Anthropic.MessageParam[] = []
    for (let i = 0; i < 12; i++) {
      history.push(toolUse(`t${i}`), toolResult(`t${i}`, i === 11 ? 25378 : 2441))
    }
    const before = toolResultBytes(history)
    const after = toolResultBytes(compactHistory(history))
    expect(after / before).toBeLessThan(0.25)
  })
})

describe('compactHistory — mixed content', () => {
  it('compacts only the tool_result blocks in a multi-block turn', () => {
    // repairToolHistory (run inside compactHistory) deliberately strips a
    // tool_result that answers no tool_use in the immediately preceding
    // assistant message — see history-compaction.ts's "boundary fragment"
    // doc comment. The fixture below originally omitted that preceding
    // toolUse('a') turn entirely, so its lone tool_result looked like an
    // orphaned boundary fragment and was stripped before this test's
    // budget/mixed-content assertions ever ran. Prepending the matching
    // toolUse('a') turn makes the tool_result a valid, in-window exchange —
    // the actual scenario this test means to exercise.
    const history: Anthropic.MessageParam[] = [
      toolUse('a'),
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'y'.repeat(20000) },
          { type: 'text', text: 'and here is my next question' },
        ],
      },
    ]
    const out = compactHistory(history, 0)
    const blocks = out[1].content as { type: string; text?: string; content?: string }[]
    expect(blocks[1]).toEqual({ type: 'text', text: 'and here is my next question' })
    expect(blocks[0].content!.length).toBeLessThan(500)
  })

  it('handles a turn carrying several tool_results at once', () => {
    // runToolLoop batches parallel tool calls into one user turn — and,
    // symmetrically, the assistant turn that requested them carries both
    // tool_use blocks together. As in the test above, repairToolHistory
    // strips a tool_result with no matching tool_use in the immediately
    // preceding assistant message, so both 'a' and 'b' need to be
    // requested in that single preceding turn or they read as orphaned
    // boundary fragments rather than the batched-parallel-calls case this
    // test is named for.
    const history: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'get_customer', input: {} },
          { type: 'tool_use', id: 'b', name: 'get_customer', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'a'.repeat(9000) },
          { type: 'tool_result', tool_use_id: 'b', content: 'b'.repeat(9000) },
        ],
      },
    ]
    const out = compactHistory(history, 9000)
    const blocks = out[1].content as { tool_use_id: string; content: string }[]
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['a', 'b'])
    // One fits the budget, the other does not.
    expect(blocks.filter((b) => b.content.length > 500)).toHaveLength(1)
  })
})
