import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { renderTranscriptForCli } from './render-transcript'
import type Anthropic from '@anthropic-ai/sdk'

describe('renderTranscriptForCli', () => {
  it('never emits a "SYSTEM:" label — validated live (2026-08-16): an in-band SYSTEM: block was flagged as a prompt-injection attempt by Claude Code and refused', () => {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'hello' }]
    const out = renderTranscriptForCli(messages)
    expect(out).not.toMatch(/SYSTEM:/i)
  })

  it('renders plain string content with a role label', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Look up the customer named Karenda.' },
    ]
    const out = renderTranscriptForCli(messages)
    expect(out).toContain('USER: Look up the customer named Karenda.')
  })

  it('renders a tool_use block as a readable "requested tool" line', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'get_customer', input: { query: 'Karenda' }, caller: { type: 'direct' } }],
      },
    ]
    const out = renderTranscriptForCli(messages)
    expect(out).toContain('ASSISTANT: [Requested tool `get_customer` with input {"query":"Karenda"}]')
  })

  it('renders a genuine tool_result with the CAYE_RUNTIME_TOOL_RESULT marker, execution_id, tool name, and status', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'get_customer', input: { query: 'Karenda' }, caller: { type: 'direct' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true,"data":{"match":"unique"}}' }],
      },
    ]
    const out = renderTranscriptForCli(messages)
    expect(out).toContain('CAYE_RUNTIME_TOOL_RESULT execution_id=t1 tool=get_customer status=success')
    expect(out).toContain('{"ok":true,"data":{"match":"unique"}}')
  })

  it('marks a failed tool_result with status=error', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'get_customer', input: {}, caller: { type: 'direct' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":false,"error":"boom"}', is_error: true }],
      },
    ]
    const out = renderTranscriptForCli(messages)
    expect(out).toContain('CAYE_RUNTIME_TOOL_RESULT execution_id=t1 tool=get_customer status=error')
  })

  it('renders a full round-trip transcript matching what was validated live against the real claude CLI', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Look up the customer named Karenda.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'get_customer', input: { query: 'Karenda' }, caller: { type: 'direct' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: '{"ok":true,"data":{"match":"unique","contact":{"name":"Karenda Rolle"}}}',
          },
        ],
      },
    ]
    const out = renderTranscriptForCli(messages)
    expect(out).toContain('USER: Look up the customer named Karenda.')
    expect(out).toContain('[Requested tool `get_customer` with input')
    expect(out).toContain('CAYE_RUNTIME_TOOL_RESULT execution_id=t1 tool=get_customer status=success')
  })
})
