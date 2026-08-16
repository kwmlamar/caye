import { createDryRunCollector, wrapToolsForDryRun } from '../tools/dry-run'
import type Anthropic from '@anthropic-ai/sdk'
import type {
  ReplayAgentRunner,
  ReplayStructuralMetrics,
  ReplayTurnInput,
  ReplayTurnResult,
} from './types'

/**
 * replay/harness.ts
 *
 * PHASE 1 of runtime convergence — the historical replay / evaluation
 * harness. This is a first-class deliverable of this phase, not a test
 * helper: it's how we prove richer situation awareness + the existing
 * `lib/caye-agent` reasoning runtime materially improves Caye on real
 * historical conversations BEFORE any production traffic moves.
 *
 * GUARANTEES
 *   - Never sends a customer or operator a message. `runReplayTurn` never
 *     calls any dispatch/outbound function; the runner it drives only
 *     talks to the Anthropic API and to dry-run-wrapped tools.
 *   - Never mutates production state. Every tool riskier than `'read'` is
 *     wrapped by `wrapToolsForDryRun` (`../tools/dry-run.ts`) before this
 *     harness ever sees it — a proposed booking, send, cancellation, or
 *     write is recorded as a `ProposedAction`, never executed. Read tools
 *     run for real because they're side-effect-free by the project's own
 *     risk taxonomy, and the harness needs real reads to reason about a
 *     real historical situation.
 *   - Does not require the production database. `runReplayTurn` takes an
 *     already-assembled `ReplayTurnInput` (system prompt + messages +
 *     tools) and an injectable `ReplayAgentRunner` — real replay against
 *     live history calls `assembleSituationFromDb`-style loaders and
 *     passes `runToolLoop` as the runner; fixture-driven tests build a
 *     `ReplayTurnInput` by hand and pass a stub runner. Neither path is
 *     privileged; this file doesn't know which one it's given.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * `ReplayStructuralMetrics` is computed here and is intentionally shallow —
 * counts, booleans, a greeting-pattern regex used only to flag replies for
 * a human to skim, never to gate anything. The richer judgments the audit
 * asks for (was this a question/directive/correction/goal, was the scope
 * right, was escalation warranted) are NOT computed automatically inside
 * this function. They're `ReplayReviewerJudgment` fields, left for a human
 * — or a clearly separate, explicitly-invoked offline grading pass, see
 * `replay/grader.ts` — to fill in after the fact. Computing them here,
 * inside the thing that runs on every replay, would be exactly the
 * classify-then-dispatch pattern the architectural audit flags as the
 * wrong direction: a hidden judgment layer between the model and the
 * outcome. This harness only observes and records what already happened.
 */

export async function runReplayTurn(
  input: ReplayTurnInput,
  runner: ReplayAgentRunner,
  client: Anthropic,
  model = 'claude-sonnet-4-6',
  maxTokens = 1024
): Promise<ReplayTurnResult> {
  const collector = createDryRunCollector()
  const dryRunTools = wrapToolsForDryRun(input.tools, collector)

  const { replyText, newTurns } = await runner({
    client,
    model,
    maxTokens,
    systemPrompt: input.systemPrompt,
    initialMessages: input.messages,
    ctx: input.ctx,
    mode: input.mode,
    tools: dryRunTools,
  })

  const toolCallRounds = newTurns.filter(
    (t) =>
      t.role === 'assistant' &&
      Array.isArray(t.content) &&
      t.content.some((b) => typeof b === 'object' && (b as { type?: string }).type === 'tool_use')
  ).length

  const structuralMetrics: ReplayStructuralMetrics = {
    producedReply: replyText.trim().length > 0,
    replyCharCount: replyText.length,
    proposedActionCount: collector.proposedActions.length,
    proposedHighRiskActionCount: collector.proposedActions.filter((a) => a.risk === 'high').length,
    toolCallRounds,
    replyOpensWithGreetingPattern: /^\s*(hi|hello|hey)\b/i.test(replyText),
  }

  return {
    meta: input.meta,
    replyText,
    proposedActions: collector.proposedActions,
    newTurns,
    structuralMetrics,
  }
}

/**
 * Run several turns and return them in order. No aggregation happens here
 * — see `replay/metrics.ts` for turning a batch of `ReplayTurnResult`s
 * into the product metrics (§8 of the runtime-convergence plan).
 */
export async function runReplayBatch(
  inputs: ReplayTurnInput[],
  runner: ReplayAgentRunner,
  client: Anthropic,
  model?: string
): Promise<ReplayTurnResult[]> {
  const results: ReplayTurnResult[] = []
  for (const input of inputs) {
    results.push(await runReplayTurn(input, runner, client, model))
  }
  return results
}
