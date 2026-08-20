import { describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { compactHistory, repairToolHistory } from './history-compaction'

const toolUse = (id: string): Anthropic.MessageParam => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'example_tool', input: {} }],
})

const toolResult = (id: string): Anthropic.MessageParam => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: '{"ok":true}' }],
})

describe('repairToolHistory', () => {
  it('drops an orphan tool_result when the sliding window starts mid-exchange', () => {
    const repaired = repairToolHistory([
      toolResult('toolu_cut_off'),
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'What else is outstanding?' },
    ])

    expect(repaired).toEqual([
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'What else is outstanding?' },
    ])
  })

  it('drops a dangling tool_use when the window ends before its result', () => {
    const repaired = repairToolHistory([
      { role: 'user', content: 'Send it.' },
      toolUse('toolu_cut_off'),
    ])

    expect(repaired).toEqual([{ role: 'user', content: 'Send it.' }])
  })

  it('keeps a valid tool_use/tool_result pair intact', () => {
    const pair = [toolUse('toolu_ok'), toolResult('toolu_ok')]
    expect(repairToolHistory(pair)).toEqual(pair)
  })

  it('preserves human text while removing an orphan tool_result block', () => {
    const repaired = repairToolHistory([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_missing', content: 'x' },
          { type: 'text', text: 'send please' },
        ],
      },
    ])

    expect(repaired).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'send please' }] },
    ])
  })

  it('runs boundary repair automatically before compaction', () => {
    const compacted = compactHistory([
      toolResult('toolu_missing'),
      { role: 'assistant', content: 'Sent to John.' },
    ])

    expect(compacted).toEqual([{ role: 'assistant', content: 'Sent to John.' }])
  })
})
