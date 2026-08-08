import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import {
  isQuietScan,
  stripQuietSentinel,
  stripQuietSentinelFromTurns,
  scrubQuietSentinel,
} from './quiet-scan'

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

  it('does NOT match the token buried mid-sentence', () => {
    expect(isQuietScan('Sue is 11 days old. NOTHING_TO_REPORT otherwise.')).toBe(false)
  })

  // Live failure, Bimini 2026-08-08. The model wrote a summary paragraph
  // and opened the SECOND paragraph with the token. The old string-start
  // check missed it, so a scan that had declared itself quiet was delivered
  // as a real finding AND the raw token rendered in Karenda's thread.
  it('recognises the token opening a later paragraph', () => {
    const real =
      "Both Juli King and Delysia Weeks have open escalations already — they're covered in the nag cadence. " +
      'Nothing new here beyond what you already have in front of you.\n\n' +
      'NOTHING_TO_REPORT — both new holds have open escalations already running.'
    expect(isQuietScan(real)).toBe(true)
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

  it('keeps the prose before a later-paragraph token', () => {
    const out = stripQuietSentinel(
      'Both have open escalations already.\n\nNOTHING_TO_REPORT — nothing new beyond that.'
    )
    expect(out).toContain('Both have open escalations already.')
    expect(out).not.toContain('NOTHING_TO_REPORT')
    expect(out).toContain('nothing new beyond that.')
  })
})

describe('scrubQuietSentinel', () => {
  // The 2026-08-08 leak needed BOTH the detector to miss and the only strip
  // to be gated behind that same detector. This runs unconditionally so the
  // presentation path can't depend on the classification being right.
  it('removes the token even from text that is not classified as quiet', () => {
    const notQuiet = 'Sue is 11 days old. NOTHING_TO_REPORT otherwise.'
    expect(isQuietScan(notQuiet)).toBe(false)
    expect(scrubQuietSentinel(notQuiet)).not.toContain('NOTHING_TO_REPORT')
    expect(scrubQuietSentinel(notQuiet)).toContain('Sue is 11 days old.')
  })

  it('leaves ordinary text untouched', () => {
    const plain = 'One item has been waiting 11 days.'
    expect(scrubQuietSentinel(plain)).toBe(plain)
  })

  it('never returns an empty string', () => {
    expect(scrubQuietSentinel('NOTHING_TO_REPORT')).toBe('Nothing needed attention this scan.')
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
