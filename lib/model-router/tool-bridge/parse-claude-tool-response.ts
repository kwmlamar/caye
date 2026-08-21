import 'server-only'
import type { ParsedToolCall, ParsedTurnResponse } from './parsed-turn-response'

/**
 * Claude Code's `--json-schema` flag exists but was tested live
 * (2026-08-16) against `--allowedTools ""` + `--max-turns 1` and deadlocked
 * — it routes structured output through an internal tool-call mechanism
 * that needs a tool grant and/or turn budget this backend deliberately
 * doesn't give it (result: `error_max_turns`, `stop_reason: 'tool_use'`,
 * null result). Loosening either would mean giving the CLI more latitude
 * than "reasoning only, zero tool access" — not on the table. Prose-fenced
 * JSON, tested clean on both the tool-call and final-text paths, is the
 * protocol instead: strict enough to validate, permissive enough not to
 * fight the CLI's own safety/turn-budget behavior.
 *
 * Strict by construction: only a response that is ENTIRELY (after
 * trimming) one ```json fenced block matching {"tool_calls":[...]} counts
 * as a tool-call round. Anything else — including a response that merely
 * mentions JSON, or wraps prose around a fence — is treated as the
 * model's final text. Ambiguity always resolves toward "this is text for
 * the operator," never toward "this is an executable instruction."
 */
export function parseClaudeFencedToolResponse(raw: string): ParsedTurnResponse {
  const trimmed = raw.trim()
  const match = /^```json\s*([\s\S]*?)\s*```$/.exec(trimmed)
  if (!match) return { kind: 'text', text: raw }

  try {
    const parsed: unknown = JSON.parse(match[1])
    const calls = extractToolCalls(parsed)
    if (calls.length > 0) return { kind: 'tool_calls', calls }
  } catch {
    // Malformed JSON inside the fence — fall through to treating the raw
    // text as the model's answer rather than guessing at intent.
  }
  return { kind: 'text', text: raw }
}

function extractToolCalls(parsed: unknown): ParsedToolCall[] {
  if (!parsed || typeof parsed !== 'object') return []
  const rawCalls = (parsed as Record<string, unknown>).tool_calls
  if (!Array.isArray(rawCalls)) return []

  const calls: ParsedToolCall[] = []
  for (const c of rawCalls) {
    if (
      c &&
      typeof c === 'object' &&
      typeof (c as Record<string, unknown>).name === 'string' &&
      'input' in (c as Record<string, unknown>)
    ) {
      calls.push({ name: (c as { name: string }).name, input: (c as { input: unknown }).input })
    }
  }
  return calls
}
