import 'server-only'
import type { GoalRow } from './types'

/**
 * Deterministic, explicit goal-priority heuristic. NOT a learned model and
 * not an LLM call — every input is a field already on the row (or a small,
 * documented derivation of it), so the score is reproducible and
 * explainable. This exists because the spec explicitly warns against
 * "opaque LLM vibes" for prioritization; a simple weighted sum that a human
 * can audit beats a plausible-sounding number nobody can check.
 *
 * Factors (spec's suggested list, narrowed to what a caye_goals row can
 * actually support without fabricating data):
 *   - priority (explicit human/founder judgment — weighted heaviest)
 *   - urgency (derived from target_date proximity, when set)
 *   - confidence (operator/founder-stated, 0-1; unset = neutral 0.5, not 0 —
 *     absence of a confidence estimate should not read as "definitely wrong")
 *
 * Deliberately excluded: "expected impact" and "cost" are not modeled as
 * scored inputs, because nothing in this schema captures either without an
 * LLM guessing a number — better to leave them out than fake precision.
 * Reversibility/risk belong to the authority layer (high-risk-gate), not
 * goal ranking — this score never decides whether an action executes, only
 * how goals are ordered for display/context.
 *
 * Range: roughly 0-100, higher = higher priority. Only meaningful as a
 * relative ordering within one workspace's active goal set, never as an
 * absolute/cross-workspace measure.
 */

const PRIORITY_WEIGHT: Record<GoalRow['priority'], number> = {
  critical: 100,
  high: 70,
  medium: 40,
  low: 15,
}

/** Days-to-target -> urgency multiplier, in [0, 1]. No date = 0, and a date
 *  180+ days out also floors to 0 — a goal with no deadline and a goal with
 *  a distant one should not be distinguishable by urgency alone (both read
 *  as "not urgent yet"), only priority/confidence separate them. Overdue or
 *  same-day = max urgency. */
function urgencyFactor(targetDate: string | null, now: Date): number {
  if (!targetDate) return 0
  const target = new Date(targetDate)
  if (Number.isNaN(target.getTime())) return 0
  const daysUntil = (target.getTime() - now.getTime()) / 86_400_000
  if (daysUntil <= 0) return 1
  if (daysUntil >= 180) return 0
  // Linear falloff from 1 (due today) to 0 (180+ days out).
  return Math.max(0, 1 - daysUntil / 180)
}

export interface PriorityScoreBreakdown {
  score: number
  priorityComponent: number
  urgencyComponent: number
  confidenceComponent: number
}

export function computePriorityScore(goal: GoalRow, now: Date = new Date()): PriorityScoreBreakdown {
  const base = PRIORITY_WEIGHT[goal.priority] ?? PRIORITY_WEIGHT.medium
  const urgency = urgencyFactor(goal.targetDate, now) * 20 // up to +20
  const confidence = (goal.confidence ?? 0.5) * 10 // up to +10, neutral when unset
  const score = Math.round(base + urgency + confidence)
  return { score, priorityComponent: base, urgencyComponent: Math.round(urgency), confidenceComponent: Math.round(confidence) }
}

export function sortByPriorityScore(goals: GoalRow[], now: Date = new Date()): GoalRow[] {
  return [...goals].sort((a, b) => computePriorityScore(b, now).score - computePriorityScore(a, now).score)
}
