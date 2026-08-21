import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { parseClaudeFencedToolResponse } from './parse-claude-tool-response'

describe('parseClaudeFencedToolResponse', () => {
  it('parses a real fenced tool-call response (captured live, claude CLI 2.1.185, 2026-08-16)', () => {
    const real = '```json\n{"tool_calls":[{"name":"get_customer","input":{"query":"Karenda"}}]}\n```'
    const result = parseClaudeFencedToolResponse(real)
    expect(result).toEqual({ kind: 'tool_calls', calls: [{ name: 'get_customer', input: { query: 'Karenda' } }] })
  })

  it('parses a real final-text response (captured live, same session, round 2 after a tool result)', () => {
    const real =
      "Found her — unique match in the system:\n\n**Name:** Karenda Rolle\n\nThat's the only record returned. Would you like to do anything with this contact, or were you just verifying she's in the system?"
    const result = parseClaudeFencedToolResponse(real)
    expect(result).toEqual({ kind: 'text', text: real })
  })

  it('treats a response with prose around a fence as text, not a tool call — ambiguity resolves toward text', () => {
    const raw = 'Sure, here:\n```json\n{"tool_calls":[{"name":"get_customer","input":{}}]}\n```\nLet me know if that helps.'
    const result = parseClaudeFencedToolResponse(raw)
    expect(result).toEqual({ kind: 'text', text: raw })
  })

  it('treats malformed JSON inside a fence as text rather than throwing', () => {
    const raw = '```json\n{"tool_calls": [not valid json\n```'
    const result = parseClaudeFencedToolResponse(raw)
    expect(result).toEqual({ kind: 'text', text: raw })
  })

  it('treats a fence with an empty tool_calls array as text (nothing to execute)', () => {
    const raw = '```json\n{"tool_calls":[]}\n```'
    const result = parseClaudeFencedToolResponse(raw)
    expect(result.kind).toBe('text')
  })

  it('supports multiple tool calls in one round', () => {
    const raw = '```json\n{"tool_calls":[{"name":"get_customer","input":{"query":"a"}},{"name":"get_team_members","input":{}}]}\n```'
    const result = parseClaudeFencedToolResponse(raw)
    expect(result).toEqual({
      kind: 'tool_calls',
      calls: [
        { name: 'get_customer', input: { query: 'a' } },
        { name: 'get_team_members', input: {} },
      ],
    })
  })
})
