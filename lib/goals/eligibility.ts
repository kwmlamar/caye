import 'server-only'
import type { ActivationCondition, GoalRow } from './types'
import { listMetrics } from './goals'

/**
 * Evaluates a 'future' goal's activation_conditions against its most
 * recently recorded metrics and reports whether it looks eligible to
 * activate. This is advisory/surfaced-only — see the migration and
 * lib/goals/types.ts doc comments. Nothing calls this and then flips
 * status; it exists purely so the dashboard can show a
 * "recommended for activation" badge for the founder to act on manually.
 *
 * sustained_days is NOT evaluated as a real rolling window in this first
 * implementation (that needs a time-series query per condition, which is
 * more machinery than a "surfaced, not applied" signal justifies right
 * now) — a condition with sustained_days set is reported as "met" based on
 * the latest observation only, with an explicit note that the sustained
 * window itself is unverified. This is a documented limitation, not a
 * silent one.
 */

export interface ConditionEvaluation {
  condition: ActivationCondition
  latestValue: number | null
  met: boolean
  note: string
}

export interface EligibilityResult {
  eligible: boolean
  hasConditions: boolean
  conditions: ConditionEvaluation[]
}

function compare(value: number, comparator: ActivationCondition['comparator'], threshold: number): boolean {
  switch (comparator) {
    case '>=': return value >= threshold
    case '<=': return value <= threshold
    case '>': return value > threshold
    case '<': return value < threshold
    case '==': return value === threshold
  }
}

export async function evaluateActivationEligibility(goal: GoalRow): Promise<EligibilityResult> {
  const conditions = goal.activationConditions ?? []
  if (conditions.length === 0) return { eligible: false, hasConditions: false, conditions: [] }

  const metrics = await listMetrics(goal.id, 200)
  const latestByKey = new Map<string, number>()
  for (const m of metrics) {
    // metrics are ordered observed_at desc, so the first hit per key is the latest.
    if (!latestByKey.has(m.metricKey)) latestByKey.set(m.metricKey, m.value)
  }

  const evaluations: ConditionEvaluation[] = conditions.map((condition) => {
    const latestValue = latestByKey.get(condition.metric_key) ?? null
    if (latestValue === null) {
      return { condition, latestValue: null, met: false, note: `no recorded metric for "${condition.metric_key}" yet` }
    }
    const met = compare(latestValue, condition.comparator, condition.threshold)
    const sustainedNote = condition.sustained_days
      ? ` (sustained_days=${condition.sustained_days} not verified as a rolling window — based on latest observation only)`
      : ''
    return { condition, latestValue, met, note: `${met ? 'met' : 'not met'}${sustainedNote}` }
  })

  return { eligible: evaluations.every((e) => e.met), hasConditions: true, conditions: evaluations }
}
