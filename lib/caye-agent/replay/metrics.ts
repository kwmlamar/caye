import type { ReplayTurnResult } from './types'

/**
 * replay/metrics.ts
 *
 * Aggregate metrics over a batch of `ReplayTurnResult`s — §8 of the
 * runtime-convergence plan.
 *
 * HONESTY CONSTRAINT: several of the requested product metrics
 * (unnecessary-clarification rate, scope-expansion rate, correct-no-action
 * rate, escalation correctness) are judgment calls that only exist once a
 * human (or the separate offline grader, `replay/grader.ts`) has filled in
 * `ReplayTurnResult.reviewerJudgment`. This module never fabricates those
 * numbers from unreviewed turns — each judgment-dependent rate is computed
 * ONLY over the reviewed subset, and `reviewedCount`/`totalTurns` is always
 * returned alongside so a summary can never look complete when most of the
 * batch hasn't actually been looked at.
 *
 * The metrics that ARE computed over every turn, unconditionally, are the
 * structural ones (`ReplayStructuralMetrics`) — counts and booleans the
 * harness observed directly, not opinions about them.
 */

export interface ReplayMetricsSummary {
  totalTurns: number
  reviewedCount: number

  // Structural — computed over every turn, no review required.
  producedReplyRate: number
  averageProposedActionsPerTurn: number
  proposedHighRiskActionRate: number
  greetingPatternRate: number

  // Judgment-dependent — computed only over `reviewedCount` turns. `null`
  // when reviewedCount is 0, rather than a misleading 0/0 → 0.
  scopeExpansionRate: number | null
  unnecessaryEscalationRate: number | null
  correctNoActionRate: number | null
}

export function summarizeReplayResults(results: ReplayTurnResult[]): ReplayMetricsSummary {
  const totalTurns = results.length
  const reviewed = results.filter((r) => r.reviewerJudgment !== undefined)
  const reviewedCount = reviewed.length

  const rate = (count: number, denom: number) => (denom === 0 ? 0 : count / denom)
  const judgedRate = (count: number, denom: number) => (denom === 0 ? null : count / denom)

  const producedReplyRate = rate(
    results.filter((r) => r.structuralMetrics.producedReply).length,
    totalTurns
  )
  const averageProposedActionsPerTurn =
    totalTurns === 0
      ? 0
      : results.reduce((sum, r) => sum + r.structuralMetrics.proposedActionCount, 0) / totalTurns
  const proposedHighRiskActionRate = rate(
    results.filter((r) => r.structuralMetrics.proposedHighRiskActionCount > 0).length,
    totalTurns
  )
  const greetingPatternRate = rate(
    results.filter((r) => r.structuralMetrics.replyOpensWithGreetingPattern).length,
    totalTurns
  )

  const scopeExpansionRate = judgedRate(
    reviewed.filter((r) => r.reviewerJudgment?.scopeMatchedDirective === false).length,
    reviewedCount
  )
  const unnecessaryEscalationRate = judgedRate(
    reviewed.filter(
      (r) => r.reviewerJudgment?.escalationOccurred === true && r.reviewerJudgment?.escalationWarranted === false
    ).length,
    reviewedCount
  )
  const correctNoActionRate = judgedRate(
    reviewed.filter((r) => r.reviewerJudgment?.correctNoAction === true).length,
    reviewedCount
  )

  return {
    totalTurns,
    reviewedCount,
    producedReplyRate,
    averageProposedActionsPerTurn,
    proposedHighRiskActionRate,
    greetingPatternRate,
    scopeExpansionRate,
    unnecessaryEscalationRate,
    correctNoActionRate,
  }
}
