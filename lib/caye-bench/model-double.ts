import type Anthropic from '@anthropic-ai/sdk'
import { generate } from '@/lib/ai/gateway'

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

/**
 * `current` receives the real `client` `loggedMessagesCreate` was called
 * with, not just `params` — v1 never needed it (every v1 turn is
 * scripted, so `client` is always the harmless `{} as never}` placeholder
 * `turn-runner.ts` passes by default), but v2's live replay mode needs a
 * genuine Anthropic client to make a real call. See `liveModelRunner`
 * below for the live-mode implementation; `scriptedRounds` (unchanged)
 * for the deterministic one — both satisfy this same signature, so
 * `modelDouble.current` can be swapped between them without either
 * caller (`turn-runner.ts`, any test) knowing which one is active.
 */
export interface ModelDoubleController {
  current: (client: Anthropic, params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message> | Anthropic.Message
}

export const modelDouble: ModelDoubleController = {
  current: () => {
    throw new Error(
      'caye-bench: loggedMessagesCreate was invoked with no model script set — call scriptedRounds() (deterministic) or liveModelRunner (real API) first.'
    )
  },
}

/**
 * The live-mode counterpart to `scriptedRounds`: makes a genuine call
 * through the canonical Caye AI gateway. Used ONLY by `replay/cli-runner.test.ts`
 * when a replay trace has no hand-written script — i.e. only by the
 * manually-invoked replay CLI, never by `npm test`'s default run. Every
 * other seam a replay turn touches (Supabase) stays mocked even in this
 * mode — see cli-runner.test.ts's own header comment for why calling the
 * real model is safe here but calling real Supabase never is.
 */
export function liveModelRunner(): ModelDoubleController['current'] {
  return async (_client, params) => (await generate({
    params,
    ctx: { source: 'lib/caye-bench/model-double.ts:liveModelRunner', task: 'agent_planning', callerRole: 'founder' },
  })).output
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
  return (_client: Anthropic) => {
    const round = rounds[Math.min(i, rounds.length - 1)]
    i += 1
    if ('text' in round) return fakeMessage([{ type: 'text', text: round.text, citations: [] }], 'end_turn')
    return fakeMessage(
      round.toolCalls.map((c) => toolUseBlock(c.name, c.args)),
      'tool_use'
    )
  }
}
