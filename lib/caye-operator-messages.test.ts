import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
// Neither dependency is exercised by the pure render/filter helpers under
// test; stubbed so the module can be imported outside a Next server runtime.
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/whatsapp/outbound', () => ({ deliveryFieldsFromResult: () => ({}) }))

import { summarizeTurnBody, isInternalOnlyBody, visibleBody } from './caye-operator-messages'
import type Anthropic from '@anthropic-ai/sdk'

/**
 * The exact turn shape behind the 2026-08-07 leak: Claude answered AND called
 * a tool in one turn, so the rendered body was text + marker. isInternalOnlyBody
 * correctly kept the row (it has real text), and the marker rode along.
 */
const MIXED_TURN: Anthropic.MessageParam = {
  role: 'assistant',
  content: [
    { type: 'text', text: "You're welcome! Anytime." },
    { type: 'tool_use', id: 'tu_1', name: 'get_held_queue', input: {} },
  ],
}

const TOOL_ONLY_TURN: Anthropic.MessageParam = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'tu_2', name: 'get_customer_history', input: {} }],
}

describe('caye-operator-messages — what a human sees in Caye Direct', () => {
  it('keeps markers in the persisted audit body', () => {
    // The stored column stays unedited — claude_format replay and the audit
    // trail both want the real turn.
    expect(summarizeTurnBody(MIXED_TURN)).toBe("You're welcome! Anytime. [tool_use: get_held_queue]")
  })

  it('shows the mixed turn without the marker', () => {
    const body = summarizeTurnBody(MIXED_TURN)
    expect(isInternalOnlyBody(body)).toBe(false)
    expect(visibleBody(body)).toBe("You're welcome! Anytime.")
    expect(visibleBody(body)).not.toContain('tool_use')
  })

  it('still hides a turn that is only a tool call', () => {
    expect(isInternalOnlyBody(summarizeTurnBody(TOOL_ONLY_TURN))).toBe(true)
  })

  it('hides an empty turn', () => {
    expect(isInternalOnlyBody(summarizeTurnBody({ role: 'assistant', content: [] }))).toBe(true)
  })

  it('leaves an ordinary text turn untouched', () => {
    const turn: Anthropic.MessageParam = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Two things worth flagging from the scan:' }],
    }
    const body = summarizeTurnBody(turn)
    expect(isInternalOnlyBody(body)).toBe(false)
    expect(visibleBody(body)).toBe('Two things worth flagging from the scan:')
  })
})
