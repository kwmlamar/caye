import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { findPrimaryBottleneck, metric, type DirectionOutcomeReadModel, type OutcomeMetric } from './outcome-model'

type Candidate = { id: string; status: string | null }
type Application = { id: string; status: string | null; prepared_at: string | null; submitted_at: string | null }
type Followup = { application_id: string; followup_type: string | null }
type Lead = { id: string; qualified_at: string | null; first_touch_sent_at: string | null; tried_at: string | null; stage: string | null }
type Receipt = { lead_id: string | null; event: string | null; event_key: string | null }
type Engagement = { workspace_id: string; engagement_type: string | null; status: string | null; amount: number | string | null; currency: string | null; ended_at: string | null }

function ids(values: Array<string | null | undefined>) { return new Set(values.filter((value): value is string => Boolean(value))) }
function value(metrics: OutcomeMetric[], key: OutcomeMetric['key']) { return metrics.find((item) => item.key === key)?.value ?? null }

/** Only receipts written by the correlated outreach-thread seam qualify as reply evidence. */
export function isAttributedOutreachReplyReceipt(row: Receipt): boolean {
  return row.event === 'human_reply_received' && Boolean(row.event_key?.startsWith('inbound:outreach:'))
}

export async function readDirectionOutcomes(): Promise<DirectionOutcomeReadModel> {
  const db = createServiceClient()
  const [candidateResult, applicationResult, followupResult, leadResult, receiptResult, engagementResult] = await Promise.all([
    db.from('job_search_candidates').select('id,status'),
    db.from('job_search_applications').select('id,status,prepared_at,submitted_at'),
    db.from('job_search_followups').select('application_id,followup_type'),
    db.from('outreach_leads').select('id,qualified_at,first_touch_sent_at,tried_at,stage'),
    db.from('sales_lifecycle_event_receipts').select('lead_id,event,event_key'),
    db.from('caye_commercial_engagements').select('workspace_id,engagement_type,status,amount,currency,ended_at'),
  ])
  for (const result of [candidateResult, applicationResult, followupResult, leadResult, receiptResult, engagementResult]) {
    if (result.error) throw new Error(`direction_outcome_read_failed:${result.error.message}`)
  }

  const candidates = (candidateResult.data ?? []) as Candidate[]
  const applications = (applicationResult.data ?? []) as Application[]
  const followups = (followupResult.data ?? []) as Followup[]
  const leads = (leadResult.data ?? []) as Lead[]
  const receipts = (receiptResult.data ?? []) as Receipt[]
  const engagements = (engagementResult.data ?? []) as Engagement[]

  const responses = ids(followups.filter((row) => row.followup_type && row.followup_type !== 'confirmation_check').map((row) => row.application_id))
  const positives = ids(followups.filter((row) => row.followup_type === 'interview_request').map((row) => row.application_id))
  const employment: OutcomeMetric[] = [
    metric('jobs_discovered', 'discovered', candidates.length, 'Canonical job_search_candidates rows.'),
    metric('jobs_qualified', 'qualified', candidates.filter((row) => row.status === 'QUEUED').length, 'Candidates in canonical QUEUED state after scoring and policy gates.'),
    metric('jobs_prepared', 'prepared', ids(applications.filter((row) => row.prepared_at).map((row) => row.id)).size, 'Applications with prepared_at recorded.'),
    metric('jobs_submitted', 'verified submissions', ids(applications.filter((row) => row.status === 'SUBMITTED' && row.submitted_at).map((row) => row.id)).size, 'Canonical SUBMITTED applications with submitted_at. Uncertain/failed attempts are excluded.'),
    metric('job_responses', 'responses', responses.size, 'Distinct correlated recruiter follow-ups excluding application confirmations.'),
    metric('job_positive_responses', 'positive responses', positives.size, 'Only explicit interview_request correlations. Generic recruiter replies are not assumed positive.'),
    metric('job_screens', 'screens', null, 'Current canonical state does not separately record completed screens.'),
    metric('job_interviews', 'interviews', null, 'Current canonical state does not record completed interviews.'),
    metric('job_offers', 'offers', null, 'Current canonical state does not record offers.'),
  ]

  const contacted = ids([...leads.filter((row) => row.first_touch_sent_at).map((row) => row.id), ...receipts.filter((row) => row.event === 'first_touch_sent').map((row) => row.lead_id)])
  const replies = ids(receipts.filter(isAttributedOutreachReplyReceipt).map((row) => row.lead_id))
  const positiveReplies = ids(leads.filter((row) => replies.has(row.id) && (Boolean(row.qualified_at) || row.stage === 'engaged' || row.stage === 'demo_started')).map((row) => row.id))
  const demos = ids(leads.filter((row) => replies.has(row.id) && (row.stage === 'demo_started' || Boolean(row.tried_at))).map((row) => row.id))
  const active = engagements.filter((row) => row.status === 'active' && !row.ended_at)
  const recurring = active.filter((row) => row.engagement_type === 'subscription')
  const currencies = ids(recurring.map((row) => row.currency?.toUpperCase()))
  const completeAmounts = recurring.every((row) => row.amount !== null && Number.isFinite(Number(row.amount)))
  const canComputeMrr = recurring.length > 0 && currencies.size === 1 && currencies.has('USD') && completeAmounts
  const mrr = canComputeMrr ? recurring.reduce((sum, row) => sum + Number(row.amount), 0) : null

  const revenue: OutcomeMetric[] = [
    metric('prospects_discovered', 'prospects discovered', leads.length, 'Canonical outreach_leads rows.'),
    metric('prospects_qualified', 'qualified', leads.filter((row) => Boolean(row.qualified_at)).length, 'Leads with qualified_at recorded.'),
    metric('prospects_contacted', 'contacted', contacted.size, 'Distinct first-touch evidence from outreach_leads and durable sales lifecycle receipts.'),
    metric('prospect_replies', 'replies', replies.size, 'Distinct human replies durably correlated to the canonical outreach conversation. Unattributed historical inbound is excluded.'),
    metric('prospect_positive_replies', 'positive replies', positiveReplies.size, 'Attributed outreach replies that subsequently reached qualified, engaged, or demo evidence.'),
    metric('prospect_demo_conversations', 'demo / conversations', demos.size, 'Attributed outreach replies that subsequently reached tried_at or demo_started evidence.'),
    metric('customers', 'verified customers', active.length ? ids(active.map((row) => row.workspace_id)).size : null, active.length ? 'Distinct workspaces with active canonical commercial engagements.' : 'Insufficient revenue evidence: operational customer rows are not proof of a paying customer.'),
    metric('mrr', 'MRR', mrr, canComputeMrr ? 'Sum of active USD subscription engagement amounts.' : 'Insufficient revenue evidence: no complete active USD subscription engagement amounts are recorded.', 'usd_monthly'),
  ]

  const employmentBottleneck = findPrimaryBottleneck([
    { label: 'discovered jobs', value: value(employment, 'jobs_discovered') }, { label: 'qualified jobs', value: value(employment, 'jobs_qualified') },
    { label: 'prepared jobs', value: value(employment, 'jobs_prepared') }, { label: 'verified submission', value: value(employment, 'jobs_submitted') },
    { label: 'responses', value: value(employment, 'job_responses') }, { label: 'positive responses', value: value(employment, 'job_positive_responses') },
  ])
  const revenueBottleneck = findPrimaryBottleneck([
    { label: 'discovered prospects', value: value(revenue, 'prospects_discovered') }, { label: 'qualified prospects', value: value(revenue, 'prospects_qualified') },
    { label: 'contacted prospects', value: value(revenue, 'prospects_contacted') }, { label: 'replies', value: value(revenue, 'prospect_replies') },
    { label: 'positive replies', value: value(revenue, 'prospect_positive_replies') }, { label: 'demo / conversations', value: value(revenue, 'prospect_demo_conversations') },
  ])
  const baselineEvidence = 'Historical baseline: insufficient comparable canonical evidence. Direction reports the current funnel without invented benchmarks.'
  return { asOf: new Date().toISOString(), employment: { key: 'employment', title: 'GET FOUNDER EMPLOYED', metrics: employment, bottleneck: employmentBottleneck, baselineEvidence }, revenue: { key: 'revenue', title: 'GROW CAYE REVENUE', metrics: revenue, bottleneck: revenueBottleneck, baselineEvidence } }
}
