export type OutcomeMetricKey =
  | 'jobs_discovered' | 'jobs_qualified' | 'jobs_prepared' | 'jobs_submitted'
  | 'job_responses' | 'job_positive_responses' | 'job_screens' | 'job_interviews' | 'job_offers'
  | 'prospects_discovered' | 'prospects_qualified' | 'prospects_contacted' | 'prospect_replies'
  | 'prospect_positive_replies' | 'prospect_demo_conversations' | 'customers' | 'mrr'

export type OutcomeMetric = { key: OutcomeMetricKey; label: string; value: number | null; unit?: 'count' | 'usd_monthly'; evidence: string }
export type OutcomeBottleneck = { from: string; to: string; conversion: number; statement: string; numerator: number; denominator: number }
export type MissionOutcome = { key: 'employment' | 'revenue'; title: string; metrics: OutcomeMetric[]; bottleneck: OutcomeBottleneck | null; baselineEvidence: string }
export type DirectionOutcomeReadModel = { asOf: string; employment: MissionOutcome; revenue: MissionOutcome }

type FunnelStage = { label: string; value: number | null }

export function findPrimaryBottleneck(stages: FunnelStage[]): OutcomeBottleneck | null {
  let worst: OutcomeBottleneck | null = null
  for (let index = 0; index < stages.length - 1; index += 1) {
    const from = stages[index]
    const to = stages[index + 1]
    if (from.value === null || to.value === null || from.value <= 0 || to.value > from.value) continue
    const conversion = to.value / from.value
    const candidate = { from: from.label, to: to.label, conversion, numerator: to.value, denominator: from.value, statement: `Only ${Math.round(conversion * 100)}% of ${from.label} currently reach ${to.label}.` }
    if (!worst || candidate.conversion < worst.conversion) worst = candidate
  }
  return worst
}

export function metric(key: OutcomeMetricKey, label: string, value: number | null, evidence: string, unit: OutcomeMetric['unit'] = 'count'): OutcomeMetric {
  return { key, label, value, evidence, unit }
}
