import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import {
  extractCodexAgentMessageText,
  extractCodexFailureMessage,
  parseCodexStructuredToolResponse,
} from './parse-codex-tool-response'

// Fixtures below are REAL stdout captured live from the installed Codex CLI
// (0.147.0, "Logged in using ChatGPT") on 2026-08-16 while validating this
// bridge's protocol design — not hand-written guesses at the event shape.

const REAL_PLAIN_TEXT_JSONL = [
  '{"type":"thread.started","thread_id":"01a00c41-9dbb-71c1-ae46-c4140d4df3d6"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}',
  '{"type":"turn.completed","usage":{"input_tokens":17029,"cached_input_tokens":11008,"cache_write_input_tokens":0,"output_tokens":6,"reasoning_output_tokens":0}}',
].join('\n')

const REAL_TOOL_CALL_JSONL = [
  '{"type":"thread.started","thread_id":"01a00c43-21d2-7c23-96b4-0f3c98b7fdae"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"tool_calls\\":[{\\"name\\":\\"get_customer\\",\\"input_json\\":\\"{\\\\\\"query\\\\\\":\\\\\\"Karenda\\\\\\"}\\"}],\\"final_text\\":null}"}}',
  '{"type":"turn.completed","usage":{"input_tokens":16858,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":59,"reasoning_output_tokens":20}}',
].join('\n')

const REAL_QUOTA_FAILURE_JSONL = [
  '{"type":"thread.started","thread_id":"01a00c41-3b26-76e3-9401-721e305f4174"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th, 2026 4:38 PM."}',
  '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th, 2026 4:38 PM."}}',
].join('\n')

describe('extractCodexAgentMessageText', () => {
  it('extracts the plain-text answer from a real turn (PONG test, captured live)', () => {
    expect(extractCodexAgentMessageText(REAL_PLAIN_TEXT_JSONL)).toBe('PONG')
  })

  it('extracts the schema-conforming JSON string from a real tool-call turn', () => {
    const text = extractCodexAgentMessageText(REAL_TOOL_CALL_JSONL)
    expect(text).toBe('{"tool_calls":[{"name":"get_customer","input_json":"{\\"query\\":\\"Karenda\\"}"}],"final_text":null}')
  })

  it('returns null when there is no item.completed agent_message event (a failed turn)', () => {
    expect(extractCodexAgentMessageText(REAL_QUOTA_FAILURE_JSONL)).toBeNull()
  })

  it('does not mistake turn.completed (which has no .text) for the answer', () => {
    // turn.completed's own JSON has no top-level `text` field — an earlier
    // buggy version of this parser assumed the LAST line was always the
    // answer and would have failed to find PONG here since turn.completed
    // is the actual last line.
    expect(extractCodexAgentMessageText(REAL_PLAIN_TEXT_JSONL)).not.toBeNull()
  })
})

describe('extractCodexFailureMessage', () => {
  it('extracts the real quota-exhaustion message from a turn.failed event', () => {
    const msg = extractCodexFailureMessage(REAL_QUOTA_FAILURE_JSONL)
    expect(msg).toContain("You've hit your usage limit")
    expect(msg).toContain('Aug 20th, 2026')
  })

  it('returns null when there is no failure event', () => {
    expect(extractCodexFailureMessage(REAL_PLAIN_TEXT_JSONL)).toBeNull()
  })
})

describe('parseCodexStructuredToolResponse', () => {
  it('parses a real tool-call agent_message into a structured call', () => {
    const agentText = extractCodexAgentMessageText(REAL_TOOL_CALL_JSONL)!
    const result = parseCodexStructuredToolResponse(agentText)
    expect(result).toEqual({ kind: 'tool_calls', calls: [{ name: 'get_customer', input: { query: 'Karenda' } }] })
  })

  it('parses a final_text response', () => {
    const result = parseCodexStructuredToolResponse('{"tool_calls":null,"final_text":"All set."}')
    expect(result).toEqual({ kind: 'text', text: 'All set.' })
  })

  it('falls back to raw text when input_json is malformed for one call, skipping just that entry', () => {
    const result = parseCodexStructuredToolResponse(
      '{"tool_calls":[{"name":"get_customer","input_json":"not json"},{"name":"get_team_members","input_json":"{}"}],"final_text":null}'
    )
    expect(result).toEqual({ kind: 'tool_calls', calls: [{ name: 'get_team_members', input: {} }] })
  })

  it('falls back to raw text when the whole payload is not valid JSON', () => {
    const raw = 'not json at all'
    expect(parseCodexStructuredToolResponse(raw)).toEqual({ kind: 'text', text: raw })
  })
})
