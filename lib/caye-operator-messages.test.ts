import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
// Neither dependency is exercised by the pure render/filter helpers under
// test; stubbed so the module can be imported outside a Next server runtime.
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/whatsapp/outbound', () => ({ deliveryFieldsFromResult: () => ({}) }))

import { summarizeTurnBody, isInternalTurnBody, visibleBody } from './caye-operator-messages'
import type Anthropic from '@anthropic-ai/sdk'

/**
 * The exact turn shape behind the 2026-08-07 leak: Claude answered AND called
 * a tool in one turn, so the rendered body was text + marker.
 */
const MIXED_TURN: Anthropic.MessageParam = {
  role: 'assistant',
  content: [
    { type: 'text', text: "You're welcome! Anytime." },
    { type: 'tool_use', id: 'tu_1', name: 'get_held_queue', input: {} },
  ],
}

/**
 * The 2026-08-12 turn, from Mrs. Max's thread. Claude narrated its plan and
 * then called two tools. The narration rendered as its own bubble directly
 * above the real answer, so the owner read the filing system's mechanics
 * before reading whether anything needed her.
 */
const NARRATION_TURN: Anthropic.MessageParam = {
  role: 'assistant',
  content: [
    {
      type: 'text',
      text: 'Let me check both the held queue and pending quotes at the same time.',
    },
    { type: 'tool_use', id: 'tu_2', name: 'get_held_queue', input: {} },
    { type: 'tool_use', id: 'tu_3', name: 'get_pending_quotes', input: {} },
  ],
}

const TOOL_ONLY_TURN: Anthropic.MessageParam = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'tu_4', name: 'get_customer_history', input: {} }],
}

describe('caye-operator-messages — what a human sees in Caye Direct', () => {
  it('keeps markers in the persisted audit body', () => {
    // The stored column stays unedited — claude_format replay and the audit
    // trail both want the real turn. Only the RENDER is filtered.
    expect(summarizeTurnBody(MIXED_TURN)).toBe("You're welcome! Anytime. [tool_use: get_held_queue]")
  })

  it('hides tool-use narration entirely, not just its marker', () => {
    // Requirement 3. The 2026-08-07 fix stripped the marker and left the
    // narration visible; that is the regression this asserts against.
    const body = summarizeTurnBody(NARRATION_TURN)
    expect(isInternalTurnBody(body)).toBe(true)
    expect(body).toContain('Let me check both the held queue')
  })

  it('hides a mixed text+tool turn, because its text is preamble not an answer', () => {
    expect(isInternalTurnBody(summarizeTurnBody(MIXED_TURN))).toBe(true)
  })

  it('still hides a turn that is only a tool call', () => {
    expect(isInternalTurnBody(summarizeTurnBody(TOOL_ONLY_TURN))).toBe(true)
  })

  it('hides a tool_result turn', () => {
    const turn: Anthropic.MessageParam = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"ok":true}' }],
    }
    expect(isInternalTurnBody(summarizeTurnBody(turn))).toBe(true)
  })

  it('hides an empty turn', () => {
    expect(isInternalTurnBody(summarizeTurnBody({ role: 'assistant', content: [] }))).toBe(true)
  })

  it('leaves a real answer — a text-only turn — untouched', () => {
    // The final turn of a tool loop has no tool_use blocks. It is the one
    // WhatsApp sends, and the one Caye Direct must show.
    const turn: Anthropic.MessageParam = {
      role: 'assistant',
      content: [{ type: 'text', text: "You're clear. Nothing waiting on you." }],
    }
    const body = summarizeTurnBody(turn)
    expect(isInternalTurnBody(body)).toBe(false)
    expect(visibleBody(body)).toBe("You're clear. Nothing waiting on you.")
  })

  it('leaves a multi-line text-only turn untouched', () => {
    const turn: Anthropic.MessageParam = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Two things worth flagging from the scan:' }],
    }
    const body = summarizeTurnBody(turn)
    expect(isInternalTurnBody(body)).toBe(false)
    expect(visibleBody(body)).toBe('Two things worth flagging from the scan:')
  })

  it('visibleBody stays a backstop — a marker never renders even unfiltered', () => {
    expect(visibleBody(summarizeTurnBody(MIXED_TURN))).not.toContain('tool_use')
  })
})
