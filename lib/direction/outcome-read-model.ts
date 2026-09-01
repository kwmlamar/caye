import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { findPrimaryBottleneck, metric, type DirectionOutcomeReadModel, type OutcomeMetric } from './outcome-model'

type CandidateRow = { id: string; status: string | null }
type ApplicationRow = { id: string; status: string | null; prepared_at: string | null; submitted_at: string | null }
type FollowupRow = { application_id: string; followup_type: string | null }
type OutreachLeadRow = {
  id: string
  qualified_at: string | null
  first_touch_sent_at: string | null
  tried_at: string | null
  stage: string | null
  status: string | null
  last_inbound_kind: string | null
}
type LifecycleReceiptRow = { lead_id: string | null; event: string | null }
type CommercialEngagementRow = {
  workspace_id: string
  engagement_type: string | null
  status: string | null
  amount: number | string | null
  currency: string | null
  ended_at: string | null
}

function unique(values: Array<string | null | undefined>) {
  return new Set(values.filter((value): value is string => Boolean(value)))
}

function stageValue(metrics: OutcomeMetric[], key: OutcomeMetric['key']) {
  return metrics.find((item) => item.key === key)?.value ?? null
}

export async function readDirectionOutcomes(): Promise<DirectionOutcomeReadModel> {
  const supabase = createServiceClient()
  const [candidatesResult, applicationsResult, followupsResult, leadsResult, lifecycleResult, commercialResult] = await Promise.all([
    supabase.from('job_search_candidates').select('id,status'),
    supabase.from('job_search_applications').select('id,status,prepared_at,submitted_at'),
    supabase.from('job_search_followups').select('application_id,followup_type'),
    supabase.from('outreach_leads').select('id,qualified_at,first_touch_sent_at,tried_at,stage,status,last_inbound_kind'),
    supabase.from('sales_lifecycle_event_receipts').select('lead_id,event'),
    supabase.from('caye_commercial_engagements').select('workspace_id,engagement_type,status,amount,currency,ended_at'),
  ])

  for (const result of [candidatesResult, applicationsResult, followupsResult, leadsResult, lifecycleResult, commercialResult]) {
    if (result.error) throw new Error(`direction_outcome_read_failed:${result.error.message}`)
  }

  const candidates = (candidatesResult.data ?? []) as CandidateRow[]
  const applications = (applicationsResult.data ?? []) as ApplicationRow[]
  const followups = (followupsResult.data ?? []) as FollowupRow[]
  const leads = (leadsResult.data ?? []) as OutreachLeadRow[]
  const lifecycle = (lifecycleResult.data ?? []) as LifecycleReceiptRow[]
  const commercial = (commercialResult.data ?? []) as CommercialEngagementRow[]

  const qualifiedJobs = candidates.filter((row) => row.status === 'QUEUED').length
  const preparedApplications = unique(applications.filter((row) => row.prepared_at).map((row) => row.id)).size
  const submittedApplications = unique(
    applications.filter((row) => row.status === 'SUBMITTED' && row.submitted_at).map((row) => row.id),
  ).size
  const responseApplicationIds = unique(
    followups.filter((row) => row.followup_type && row.followup_type !== 'confirmation_check').map((row) => row.application_id),
  )
  // Current-main correlation only has confirmation_check, recruiter_reply and
  // interview_request. recruiter_reply is not semantically guaranteed positive,
  // so only the explicit interview request is counted as positive evidence.
  const positiveApplicationIds = unique(
    followups.filter((row) => row.followup_type === 'interview_request').map((row) => row.application_id),
  )

  const employmentMetrics: OutcomeMetric[] = [
    metric('jobs_discovered', 'discovered', candidates.length, 'Canonical job_search_candidates rows.'),
    metric('jobs_qualified', 'qualified', qualifiedJobs, 'Candidates in canonical QUEUED state after scoring/policy gates.'),
    metric('jobs_prepared', 'prepared', preparedApplications, 'Applications with prepared_at recorded.'),
    metric('jobs_submitted', 'verified submissions', submittedApplications, 'Applications in SUBMITTED with submitted_at; uncertain/failed attempts are excluded.'),
    metric('job_responses', 'responses', responseApplicationIds.size, 'Distinct correlated recruiter follow-ups excluding application confirmations.'),
    metric('job_positive_responses', 'positive responses', positiveApplicationIds.size, 'Only explicit interview_request correlations; generic recruiter replies are not assumed positive.'),
    metric('job_screens', 'screens', null, 'Current canonical state does not distinguish completed screens from interview requests.'),
    metric('job_interviews', 'interviews', null, 'Current canonical state does not record completed interviews.'),
    metric('job_offers', 'offers', null, 'Current canonical state does not record offers.'),
  ]

  const firstTouchLeadIds = unique([
    ...leads.filter((row) => row.first_touch_sent_at).map((row) => row.id),
    ...lifecycle.filter((row) => row.event === 'first_touch_sent').map((row) => row.lead_id),
  ])
  const replyLeadIds = unique([
    ...leads.filter((row) => row.last_inbound_kind === 'human_reply').map((row) => row.id),
    ...lifecycle.filter((row) => row.event === 'human_reply_received').map((row) => row.lead_id),
  ])
  const positiveReplyLeadIds = unique(
    leads
      .filter((row) => replyLeadIds.has(row.id) && (row.stage === 'engaged' || row.stage === 'demo_started' || Boolean(row.tried_at)))
      .map((row) => row.id),
  )
  const demoLeadIds = unique(
    leads.filter((row) => row.stage === 'demo_started' || Boolean(row.tried_at)).map((row) => row.id),
  )

  const activeCommercial = commercial.filter((row) => row.status === 'active' && !row.ended_at)
  const customerWorkspaceIds = unique(activeCommercial.map((row) => row.workspace_id))
  const recurring = activeCommercial.filter((row) => row.engagement_type === 'subscription')
  const currencies = unique(recurring.map((row) => row.currency?.toUpperCase()))
  const hasCompleteAmounts = recurring.every((row) => row.amount !== null && Number.isFinite(Number(row.amount)))
  const canComputeMrr = recurring.length > 0 && currencies.size === 1 && currencies.has('USD') && hasCompleteAmounts
  const mrr = canComputeMrr ? recurring.reduce((sum, row) => sum + Number(row.amount), 0) : null
  const hasCommercialEvidence = activeCommercial.length > 0

  const revenueMetrics: OutcomeMetric[] = [
    metric('prospects_discovered', 'prospects discovered', leads.length, 'Canonical outreach_leads rows.'),
    metric('prospects_qualified', 'qualified', leads.filter((row) => Boolean(row.qualified_at)).length, 'Leads with qualified_at recorded.'),
    metric('prospects_contacted', 'contacted', firstTouchLeadIds.size, 'Distinct leads with first_touch_sent_at or a durable first_touch_sent lifecycle receipt.'),
    metric('prospect_replies', 'replies', replyLeadIds.size, 'Distinct leads with human_reply evidence; opt-outs and automated traffic are excluded.'),
    metric('prospect_positive_replies', 'positive replies', positiveReplyLeadIds.size, 'Human-reply leads that reached engaged/demo evidence; descriptive website evidence is never treated as intent.'),
    metric('prospect_demo_conversations', 'demo / conversations', demoLeadIds.size, 'Distinct leads with tried_at or demo_started stage.'),
    metric('customers', 'verified customers', hasCommercialEvidence ? customerWorkspaceIds.size : null, hasCommercialEvidence ? 'Distinct workspaces with active canonical commercial engagements.' : 'Insufficient revenue evidence: operational customer rows exist, but no active commercial engagement is recorded.'),
    metric('mrr', 'MRR', mrr, canComputeMrr ? 'Sum of active USD subscription engagement amounts.' : 'Insufficient revenue evidence: no complete active USD subscription engagement amounts are recorded.', 'usd_monthly'),
  ]

  const employmentBottleneck = findPrimaryBottleneck([
    { label: 'discovered jobs', value: stageValue(employmentMetrics, 'jobs_discovered') },
    { label: 'qualified jobs', value: stageValue(employmentMetrics, 'jobs_qualified') },
    { label: 'prepared jobs', value: stageValue(employmentMetrics, 'jobs_prepared') },
    { label: 'verified submission', value: stageValue(employmentMetrics, 'jobs_submitted') },
    { label: 'responses', value: stageValue(employmentMetrics, 'job_responses') },
    { label: 'positive responses', value: stageValue(employmentMetrics, 'job_positive_responses') },
  ])

  const revenueBottleneck = findPrimaryBottleneck([
    { label: 'discovered prospects', value: stageValue(revenueMetrics, 'prospects_discovered') },
    { label: 'qualified prospects', value: stageValue(revenueMetrics, 'prospects_qualified') },
    { label: 'contacted prospects', value: stageValue(revenueMetrics, 'prospects_contacted') },
    { label: 'replies', value: stageValue(revenueMetrics, 'prospect_replies') },
    { label: 'positive replies', value: stageValue(revenueMetrics, 'prospect_positive_replies') },
    { label: 'demo / conversations', value: stageValue(revenueMetrics, 'prospect_demo_conversations') },
  ])

  return {
    asOf: new Date().toISOString(),
    employment: {
      key: 'employment',
      title: 'GET FOUNDER EMPLOYED',
      metrics: employmentMetrics,
      bottleneck: employmentBottleneck,
      baselineEvidence: 'Historical baseline: insufficient comparable canonical evidence. Direction reports the current funnel without invented benchmarks.',
    },
    revenue: {
      key: 'revenue',
      title: 'GROW CAYE REVENUE',
      metrics: revenueMetrics,
      bottleneck: revenueBottleneck,
      baselineEvidence: 'Historical baseline: insufficient comparable canonical evidence. Direction reports the current funnel without invented benchmarks.',
    },
  }
}
