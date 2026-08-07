import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { isQuietScan, stripQuietSentinel, stripQuietSentinelFromTurns } from './quiet-scan'

describe('isQuietScan', () => {
  it('recognises the token with a trailing sentence', () => {
    expect(isQuietScan('NOTHING_TO_REPORT — quiet round, nothing new since 10am.')).toBe(true)
  })

  it('recognises the bare token and tolerates leading whitespace', () => {
    expect(isQuietScan('NOTHING_TO_REPORT')).toBe(true)
    expect(isQuietScan('\n  NOTHING_TO_REPORT\n')).toBe(true)
  })

  // The whole point of the token: prose that *means* "nothing new" is not
  // a quiet signal, because the model writes exactly this while still
  // attaching a finding underneath it. Live 2026-08-06: "Nothing new since
  // the last scan — no new held items… One escalation to report: …".
  it('does NOT treat prose that merely says nothing-new as quiet', () => {
    expect(isQuietScan('Nothing new since the last scan — no new held items.')).toBe(false)
    expect(isQuietScan('Nothing new this scan.\n\nOne item has been waiting 11 days:')).toBe(false)
  })

  it('does NOT match the token buried mid-reply', () => {
    expect(isQuietScan('Sue is 11 days old. NOTHING_TO_REPORT otherwise.')).toBe(false)
  })
})

describe('stripQuietSentinel', () => {
  it('drops the token and its separator', () => {
    expect(stripQuietSentinel('NOTHING_TO_REPORT — quiet round.')).toBe('quiet round.')
    expect(stripQuietSentinel('NOTHING_TO_REPORT: all clear')).toBe('all clear')
  })

  it('falls back to a readable line when the token stands alone', () => {
    expect(stripQuietSentinel('NOTHING_TO_REPORT')).toBe('Nothing needed attention this scan.')
  })
})

describe('stripQuietSentinelFromTurns', () => {
  const toolTurn: Anthropic.MessageParam = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'get_held_queue', input: {} }],
  }
  const resultTurn: Anthropic.MessageParam = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
  }

  it('rewrites only the final assistant text turn', () => {
    const turns: Anthropic.MessageParam[] = [
      toolTurn,
      resultTurn,
      { role: 'assistant', content: [{ type: 'text', text: 'NOTHING_TO_REPORT — all quiet.' }] },
    ]
    const out = stripQuietSentinelFromTurns(turns)
    expect(out[0]).toBe(toolTurn)
    expect(out[1]).toBe(resultTurn)
    expect(out[2].content).toEqual([{ type: 'text', text: 'all quiet.' }])
  })

  it('handles a string-content turn', () => {
    const out = stripQuietSentinelFromTurns([{ role: 'assistant', content: 'NOTHING_TO_REPORT quiet' }])
    expect(out[0].content).toBe('quiet')
  })

  it('leaves a non-quiet reply untouched', () => {
    const turns: Anthropic.MessageParam[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'Sue has been waiting 11 days.' }] },
    ]
    expect(stripQuietSentinelFromTurns(turns)).toEqual(turns)
  })

  it('is a no-op when there is no assistant turn', () => {
    const turns: Anthropic.MessageParam[] = [resultTurn]
    expect(stripQuietSentinelFromTurns(turns)).toEqual(turns)
  })
})
