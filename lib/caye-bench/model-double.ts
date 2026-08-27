import type Anthropic from '@anthropic-ai/sdk'

/**
 * model-double.ts
 *
 * The production adapter (production-adapter.ts) drives the REAL
 * `runToolLoop` (`lib/caye-agent/execute.ts`) for every scenario turn —
 * role gating, the high-risk stage/confirm gate, the action-claim-guard
 * backstop, front-desk's forced tool_choice, and iteration limits are all
 * production code, unmodified. The ONE seam this mocks is the same one
 * every other test in this codebase mocks: `loggedMessagesCreate`
 * (`@/lib/llm-telemetry`), `runToolLoop`'s only call site that reaches the
 * model. Caye Bench never calls the real Anthropic API — every scenario is
 * a deterministic fixture, per the harness's own design constraint.
 *
 * `modelDouble.current` is a mutable box, not a fixed mock body, because
 * each turn needs a DIFFERENT scripted sequence of model responses and
 * vi.mock's factory is hoisted once per test file. The adapter sets
 * `modelDouble.current` to a fresh `scriptedRounds(...)` closure
 * immediately before each `runToolLoop` call and awaits it fully before
 * starting the next — two turns racing each other would corrupt whichever
 * script the second one intended to run.
 */

export type BenchModelRound =
  | { toolCalls: Array<{ name: string; args: unknown }> }
  | { text: string }

export interface ModelDoubleController {
  current: (params: { messages: Anthropic.MessageParam[] }) => Anthropic.Message
}

export const modelDouble: ModelDoubleController = {
  current: () => {
    throw new Error(
      'caye-bench: loggedMessagesCreate was invoked with no model script set — every production-adapter turn must call scriptedRounds() first.'
    )
  },
}

let callSeq = 0

// Built as plain objects and cast via `unknown` rather than fully typed —
// `runToolLoop` only ever reads `.content` off the returned message (see
// execute.ts), so this only needs to satisfy that read, not the SDK's
// full response shape (which varies across SDK versions, e.g. the
// `caller` field on `ToolUseBlock`). Same pattern other tests in this
// codebase use for the untyped `client` param (`{} as never`).
function toolUseBlock(name: string, args: unknown): Anthropic.ToolUseBlock {
  callSeq += 1
  return { type: 'tool_use', id: `bench_call_${callSeq}`, name, input: args } as unknown as Anthropic.ToolUseBlock
}

function fakeMessage(content: Anthropic.ContentBlock[], stopReason: Anthropic.Message['stop_reason']): Anthropic.Message {
  return {
    id: `bench_msg_${callSeq}`,
    type: 'message',
    role: 'assistant',
    model: 'caye-bench-fake',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
  } as unknown as Anthropic.Message
}

/**
 * Turns a fixed list of scripted rounds into a `loggedMessagesCreate`
 * stand-in. Round `i` answers the `i`-th call `runToolLoop` makes for
 * this turn. If the loop asks for more rounds than were scripted, the
 * last round repeats — a missing final `{ text }` round then reliably
 * shows up as `ranOutOfIterations`-shaped behavior instead of a confusing
 * crash mid-loop.
 */
export function scriptedRounds(rounds: BenchModelRound[]): ModelDoubleController['current'] {
  if (rounds.length === 0) throw new Error('scriptedRounds: at least one round is required')
  let i = 0
  return () => {
    const round = rounds[Math.min(i, rounds.length - 1)]
    i += 1
    if ('text' in round) return fakeMessage([{ type: 'text', text: round.text, citations: [] }], 'end_turn')
    return fakeMessage(
      round.toolCalls.map((c) => toolUseBlock(c.name, c.args)),
      'tool_use'
    )
  }
}
