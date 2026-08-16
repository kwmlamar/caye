import type Anthropic from '@anthropic-ai/sdk'
import type { ToolLoopArgs, ToolLoopResult } from '../execute'
import { createDryRunCollector, type DryRunCollector, type ProposedAction } from '../tools/dry-run'
import { createFakePendingActionsStore, type FakePendingActionsStore } from './fake-high-risk-gate'
import type { ToolContext, ToolMode, Tool } from '../tools/types'

/**
 * replay/job-harness.ts
 *
 * PHASE 3 — extends the Phase 1 single-turn replay harness
 * (replay/harness.ts) to OPERATIONAL SEQUENCES: several human turns in a
 * row, with real conversation history and real staged-action state
 * (via fake-high-risk-gate.ts) carried between them, rather than one
 * isolated model call.
 *
 * Deliberately NOT built on top of `runReplayTurn` — that function wraps
 * every non-read tool with `wrapToolsForDryRun`, which replaces its
 * execute() outright and would erase the stage/confirm mechanic a
 * multi-turn job needs to actually exercise. Callers of this harness pass
 * tools that are ALREADY the right shape for a job: high-risk tools
 * pre-wrapped with `wrapWithFakeHighRiskGate` (so staging/confirmation/
 * supersession genuinely run), read tools passed through unwrapped (real
 * reads, same as every other replay path in this codebase — side-effect-
 * free by the project's own risk taxonomy).
 *
 * The dry-run collector is still the only place a "would-be" mutation is
 * ever recorded — `wrapWithFakeHighRiskGate`'s confirming branch pushes
 * into it instead of calling any real send/booking function, exactly
 * mirroring `wrapToolsForDryRun`'s behavior for the single-turn harness.
 */

type ReplayJobRunner = (args: ToolLoopArgs) => Promise<ToolLoopResult>

export interface ReplayJobState {
  history: Anthropic.MessageParam[]
  pendingStore: FakePendingActionsStore
  collector: DryRunCollector
}

export function createReplayJobState(): ReplayJobState {
  return {
    history: [],
    pendingStore: createFakePendingActionsStore(),
    collector: createDryRunCollector(),
  }
}

export interface ReplayJobTurnArgs {
  userMessage: string
  systemPrompt: string
  tools: Tool<never>[]
  ctx: ToolContext
  mode: ToolMode
  runner: ReplayJobRunner
  client: Anthropic
  model?: string
  maxTokens?: number
}

export interface ReplayJobTurnResult {
  replyText: string
  newTurns: Anthropic.MessageParam[]
  newProposedActions: ProposedAction[]
  toolCallRounds: number
}

/**
 * Runs one human turn of a job: appends `userMessage` to the job's running
 * history, calls the runner (`runToolLoop`), appends whatever the model
 * produced back onto the SAME history array so the next call in the same
 * job sees full continuity, and returns just the delta for this turn
 * (new proposed actions this turn, not the job's running total — read
 * `state.collector.proposedActions` for the whole job's history).
 */
export async function runReplayJobTurn(
  state: ReplayJobState,
  args: ReplayJobTurnArgs
): Promise<ReplayJobTurnResult> {
  const beforeActionCount = state.collector.proposedActions.length
  state.history.push({ role: 'user', content: args.userMessage })

  const result = await args.runner({
    client: args.client,
    model: args.model ?? 'claude-sonnet-4-6',
    maxTokens: args.maxTokens ?? 1024,
    systemPrompt: args.systemPrompt,
    initialMessages: state.history,
    ctx: args.ctx,
    mode: args.mode,
    tools: args.tools,
  })

  state.history.push(...result.newTurns)

  const toolCallRounds = result.newTurns.filter(
    (t) =>
      t.role === 'assistant' &&
      Array.isArray(t.content) &&
      t.content.some((b) => typeof b === 'object' && (b as { type?: string }).type === 'tool_use')
  ).length

  return {
    replyText: result.replyText,
    newTurns: result.newTurns,
    newProposedActions: state.collector.proposedActions.slice(beforeActionCount),
    toolCallRounds,
  }
}
