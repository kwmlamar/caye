import 'server-only'
import type { ParsedToolCall, ParsedTurnResponse } from './parsed-turn-response'

/**
 * Codex has real JSON-Schema-constrained output (`--output-schema <file>`,
 * OpenAI strict mode) — tested live (2026-08-16) and preferred over Claude's
 * prose-fenced-JSON protocol precisely because it's schema-enforced by the
 * provider, not just prompt-compliance-dependent. One real constraint
 * discovered in that testing: strict mode requires `additionalProperties:
 * false` at every object level, which forbids an open/arbitrary-shaped
 * `input` object for tool arguments (they vary per tool). Arguments
 * therefore travel as `input_json` — a STRING holding the serialized JSON
 * — which this module parses and which schema-validate.ts then validates
 * against the real tool's inputSchema, same as the Claude path.
 *
 * `codex exec --json` emits JSONL events to stdout; the final answer is
 * NOT a top-level field on the last line — it's nested at an
 * `item.completed` event with `item.type === 'agent_message'`, at
 * `item.item.text`. That text is itself a JSON string matching
 * codex-output-schema.json. Verified against the installed CLI (0.147.0);
 * an earlier version of this parser assumed a top-level `.text` field on
 * the last JSONL line and would have silently returned garbage.
 */
export function extractCodexAgentMessageText(stdoutJsonl: string): string | null {
  const lines = stdoutJsonl.trim().split('\n').filter(Boolean)
  let last: string | null = null
  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as Record<string, unknown>
      if (evt.type === 'item.completed') {
        const item = evt.item as Record<string, unknown> | undefined
        if (item?.type === 'agent_message' && typeof item.text === 'string') {
          last = item.text
        }
      }
    } catch {
      continue
    }
  }
  return last
}

/**
 * `turn.failed`/`error` events carry the real provider error message (e.g.
 * the live-observed "You've hit your usage limit. Upgrade to Pro...")
 * separately from process exit code — a nonzero exit alone doesn't say
 * WHY. Read this before falling back to a generic exit-code classification.
 */
export function extractCodexFailureMessage(stdoutJsonl: string): string | null {
  const lines = stdoutJsonl.trim().split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const evt = JSON.parse(lines[i]) as Record<string, unknown>
      if (evt.type === 'turn.failed') {
        const err = evt.error as Record<string, unknown> | undefined
        if (typeof err?.message === 'string') return err.message
      }
      if (evt.type === 'error' && typeof evt.message === 'string') {
        return evt.message
      }
    } catch {
      continue
    }
  }
  return null
}

export function parseCodexStructuredToolResponse(agentMessageText: string): ParsedTurnResponse {
  try {
    const parsed = JSON.parse(agentMessageText) as { tool_calls?: unknown; final_text?: unknown }
    if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
      const calls = extractToolCalls(parsed.tool_calls)
      if (calls.length > 0) return { kind: 'tool_calls', calls }
    }
    if (typeof parsed.final_text === 'string') {
      return { kind: 'text', text: parsed.final_text }
    }
  } catch {
    // Not valid JSON despite the schema constraint (shouldn't happen, but
    // never trust it blindly) — fall back to the raw text as the answer.
  }
  return { kind: 'text', text: agentMessageText }
}

function extractToolCalls(rawCalls: unknown[]): ParsedToolCall[] {
  const calls: ParsedToolCall[] = []
  for (const c of rawCalls) {
    if (
      !c ||
      typeof c !== 'object' ||
      typeof (c as Record<string, unknown>).name !== 'string' ||
      typeof (c as Record<string, unknown>).input_json !== 'string'
    ) {
      continue
    }
    try {
      const input: unknown = JSON.parse((c as { input_json: string }).input_json)
      calls.push({ name: (c as { name: string }).name, input })
    } catch {
      // Malformed input_json for this one call — skip it rather than fail the whole round.
    }
  }
  return calls
}
