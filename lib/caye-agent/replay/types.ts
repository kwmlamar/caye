import type Anthropic from '@anthropic-ai/sdk'
import type { Tool, ToolContext, ToolMode } from '../tools/types'
import type { ProposedAction } from '../tools/dry-run'
import type { CayeSituation } from '../situation'

/**
 * replay/types.ts
 *
 * PHASE 1 of runtime convergence. Shared types for the historical replay /
 * evaluation harness. See replay/harness.ts for the runner and
 * replay/README.md-equivalent doc comments there for the guarantees this
 * makes (no sends, no mutation, dry-run action interception).
 */

export interface ReplayCaseMeta {
  /** Short stable id, e.g. 'nbc-laney-scope'. Used as the test/fixture key. */
  caseId: string
  label: string
  /** What this fixture is checking and why — the historical failure or
   *  success it reconstructs. For a human reading replay output. */
  description: string
}

/**
 * One turn to replay: a fully-assembled situation, a system prompt built
 * from it, and the tools that should be offered (already risk-tagged;
 * the harness applies dry-run wrapping, callers must not pre-wrap).
 */
export interface ReplayTurnInput {
  meta: ReplayCaseMeta
  mode: ToolMode
  systemPrompt: string
  /** Full message array to send this turn — normally the situation's
   *  annotated history plus the new inbound turn already appended. */
  messages: Anthropic.MessageParam[]
  ctx: ToolContext
  /** Tools this turn may call. Read tools run for real (see dry-run.ts);
   *  everything else is intercepted and recorded, never executed. */
  tools: Tool<never>[]
  /** The situation this turn was assembled from, kept for the evaluation
   *  record even though it isn't sent to the model directly (it informed
   *  systemPrompt/messages). Optional — fixtures that build messages by
   *  hand without going through assembleSituation may omit it. */
  situation?: CayeSituation
}

/** Deterministic, code-computed observations. Never a judgment call —
 *  see ReplayReviewerJudgment for the fields that are. */
export interface ReplayStructuralMetrics {
  producedReply: boolean
  replyCharCount: number
  proposedActionCount: number
  proposedHighRiskActionCount: number
  toolCallRounds: number
  /** Heuristic label ONLY — a leading "hi"/"hello"/"hey" in the reply.
   *  This is not a rule Caye follows and does not gate anything; it exists
   *  so a human scanning replay output for the continuity fixture doesn't
   *  have to read every reply by eye. Treat it as a highlighter, not a
   *  verdict — see replay/harness.ts's header comment on why this must
   *  never become a runtime classifier. */
  replyOpensWithGreetingPattern: boolean
}

/**
 * Judgment calls the audit explicitly says belong to a person (or a
 * clearly separate, offline grading pass — see replay/grader.ts) rather
 * than to code inside Caye's reasoning path. `runReplayTurn` never fills
 * these in; they exist as a place to attach a verdict after the fact.
 */
export interface ReplayReviewerJudgment {
  intentType?: 'question' | 'directive' | 'correction' | 'goal'
  inferredScope?: string
  scopeMatchedDirective?: boolean
  escalationWarranted?: boolean
  escalationOccurred?: boolean
  correctNoAction?: boolean
  notes?: string
}

export interface ReplayTurnResult {
  meta: ReplayCaseMeta
  replyText: string
  proposedActions: ProposedAction[]
  newTurns: Anthropic.MessageParam[]
  structuralMetrics: ReplayStructuralMetrics
  reviewerJudgment?: ReplayReviewerJudgment
}

/**
 * The function signature `runReplayTurn` drives — matches
 * `lib/caye-agent/execute.ts`'s `runToolLoop` exactly, on purpose, so the
 * default runner used for a real replay IS `runToolLoop` (the proven
 * mechanism), and a test can inject a stub with the same shape without any
 * network or database access.
 */
export interface ReplayAgentRunner {
  (args: {
    client: Anthropic
    model: string
    maxTokens: number
    systemPrompt: string
    initialMessages: Anthropic.MessageParam[]
    ctx: ToolContext
    mode?: ToolMode
    tools?: Tool<never>[]
  }): Promise<{ replyText: string; newTurns: Anthropic.MessageParam[] }>
}
