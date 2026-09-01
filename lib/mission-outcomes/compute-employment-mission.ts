/**
 * Employment mission outcome computation
 * Reads job_search_* tables, computes weekly funnel metrics, generates intelligence
 */

import { createClient } from '@supabase/supabase-js'

interface EmploymentWeeklyMetrics {
  weekEnding: Date
  jobsDiscovered: number
  jobsQualified: number
  qualificationRate: number
  applicationsAttempted: number
  applicationsSubmitted: number
  submissionSuccessRate: number
  responsesReceived: number
  responseRate: number
  positiveResponses: number
  positiveResponseRate: number
  screensScheduled: number
  screenToInterviewRate: number
  interviewsCompleted: number
  interviewToOfferRate: number
  offersReceived: number
  primaryBottleneck: string | null
  recommendedAction: string | null
}

const BENCHMARKS = {
  qualificationRate: 70,
  submissionSuccessRate: 80,
  responseRate: 15,
  positiveResponseRate: 40,
  screenToInterviewRate: 60,
}

export async function computeEmploymentMissionOutcomes(
  weekEnding: Date,
  supabaseUrl: string,
  supabaseServiceKey: string
): Promise<EmploymentWeeklyMetrics> {
  const client = createClient(supabaseUrl, supabaseServiceKey)

  // Week bounds
  const weekStart = new Date(weekEnding)
  weekStart.setDate(weekStart.getDate() - 6)
  weekStart.setHours(0, 0, 0, 0)

  const weekEnd = new Date(weekEnding)
  weekEnd.setHours(23, 59, 59, 999)

  // Query 1: Jobs discovered vs qualified
  const { data: candidates, error: candidatesError } = await client
    .from('job_search_candidates')
    .select('id, fit_score')
    .gte('discovered_at', weekStart.toISOString())
    .lte('discovered_at', weekEnd.toISOString())

  if (candidatesError) throw candidatesError

  const jobsDiscovered = candidates?.length || 0
  const jobsQualified = candidates?.filter((c) => c.fit_score >= 65).length || 0
  const qualificationRate = jobsDiscovered > 0 ? (jobsQualified / jobsDiscovered) * 100 : 0

  // Query 2: Applications attempted vs submitted
  const { data: applications, error: applicationsError } = await client
    .from('job_search_applications')
    .select('id, status, submitted_at, response_status')
    .gte('prepared_at', weekStart.toISOString())
    .lte('prepared_at', weekEnd.toISOString())

  if (applicationsError) throw applicationsError

  const applicationsAttempted = applications?.length || 0
  const applicationsSubmitted = applications?.filter((a) => a.status === 'SUBMITTED').length || 0
  const submissionSuccessRate =
    applicationsAttempted > 0 ? (applicationsSubmitted / applicationsAttempted) * 100 : 0

  // Query 3: Responses received
  const submittedApps = applications?.filter((a) => a.status === 'SUBMITTED') || []
  const responsesReceived = submittedApps.filter((a) => a.response_status === 'responded').length
  const positiveResponses = submittedApps.filter(
    (a) => a.response_status === 'positive'
  ).length
  const responseRate = submittedApps.length > 0 ? (responsesReceived / submittedApps.length) * 100 : 0
  const positiveResponseRate =
    responsesReceived > 0 ? (positiveResponses / responsesReceived) * 100 : 0

  // Query 4: Interviews
  const { data: interviews, error: interviewsError } = await client
    .from('job_search_applications')
    .select('id, status')
    .eq('status', 'INTERVIEW')
    .gte('updated_at', weekStart.toISOString())
    .lte('updated_at', weekEnd.toISOString())

  if (interviewsError) throw interviewsError

  const screensScheduled = submittedApps.filter((a) => a.response_status === 'screening').length
  const interviewsCompleted = interviews?.length || 0
  const screenToInterviewRate =
    screensScheduled > 0 ? (interviewsCompleted / screensScheduled) * 100 : 0

  // Query 5: Offers
  const { data: offers, error: offersError } = await client
    .from('job_search_applications')
    .select('id')
    .eq('status', 'OFFER')
    .gte('updated_at', weekStart.toISOString())
    .lte('updated_at', weekEnd.toISOString())

  if (offersError) throw offersError

  const offersReceived = offers?.length || 0
  const interviewToOfferRate =
    interviewsCompleted > 0 ? (offersReceived / interviewsCompleted) * 100 : 0

  // Bottleneck detection
  const bottlenecks: Array<{ segment: string; rate: number; benchmark: number }> = []

  if (qualificationRate < BENCHMARKS.qualificationRate && jobsDiscovered > 5) {
    bottlenecks.push({
      segment: 'qualification',
      rate: qualificationRate,
      benchmark: BENCHMARKS.qualificationRate,
    })
  }

  if (submissionSuccessRate < BENCHMARKS.submissionSuccessRate && applicationsAttempted > 3) {
    bottlenecks.push({
      segment: 'submission_success',
      rate: submissionSuccessRate,
      benchmark: BENCHMARKS.submissionSuccessRate,
    })
  }

  if (responseRate < BENCHMARKS.responseRate && applicationsSubmitted > 10) {
    bottlenecks.push({
      segment: 'response',
      rate: responseRate,
      benchmark: BENCHMARKS.responseRate,
    })
  }

  if (positiveResponseRate < BENCHMARKS.positiveResponseRate && responsesReceived > 5) {
    bottlenecks.push({
      segment: 'positive_response',
      rate: positiveResponseRate,
      benchmark: BENCHMARKS.positiveResponseRate,
    })
  }

  // Sort by impact (variance from benchmark)
  bottlenecks.sort((a, b) => (a.benchmark - a.rate) - (b.benchmark - b.rate))

  const primaryBottleneck = bottlenecks[0]?.segment || null
  const recommendedAction = getRecommendedAction(primaryBottleneck, qualificationRate)

  return {
    weekEnding,
    jobsDiscovered,
    jobsQualified,
    qualificationRate,
    applicationsAttempted,
    applicationsSubmitted,
    submissionSuccessRate,
    responsesReceived,
    responseRate,
    positiveResponses,
    positiveResponseRate,
    screensScheduled,
    screenToInterviewRate,
    interviewsCompleted,
    interviewToOfferRate,
    offersReceived,
    primaryBottleneck,
    recommendedAction,
  }
}

function getRecommendedAction(bottleneck: string | null, qualificationRate: number): string | null {
  switch (bottleneck) {
    case 'qualification':
      return qualificationRate < 50
        ? 'Broaden job source filters; current targeting is too strict'
        : 'Tighten job source filters; too many misses in pipeline'

    case 'submission_success':
      return 'Review job_search_execution_attempts for field resolution failures; improve ATS form parsing'

    case 'response':
      return 'Audit submitted job titles vs target_titles; test resume variants for click-through'

    case 'positive_response':
      return 'A/B test resume content; review rejection feedback for common objections'

    case 'screen_to_interview':
      return 'Collect screen feedback; improve fit assessment or interview prep'

    default:
      return null
  }
}

/**
 * Store computed metrics in employment_mission_weekly
 */
export async function storeEmploymentMissionMetrics(
  metrics: EmploymentWeeklyMetrics,
  supabaseUrl: string,
  supabaseServiceKey: string
) {
  const client = createClient(supabaseUrl, supabaseServiceKey)

  const { error } = await client.from('employment_mission_weekly').upsert(
    {
      week_ending: metrics.weekEnding,
      jobs_discovered: metrics.jobsDiscovered,
      jobs_qualified: metrics.jobsQualified,
      qualification_rate_pct: Math.round(metrics.qualificationRate * 100) / 100,
      applications_attempted: metrics.applicationsAttempted,
      applications_submitted: metrics.applicationsSubmitted,
      submission_success_rate_pct: Math.round(metrics.submissionSuccessRate * 100) / 100,
      responses_received: metrics.responsesReceived,
      response_rate_pct: Math.round(metrics.responseRate * 100) / 100,
      positive_responses: metrics.positiveResponses,
      positive_response_rate_pct: Math.round(metrics.positiveResponseRate * 100) / 100,
      screens_scheduled: metrics.screensScheduled,
      screen_to_interview_rate_pct: Math.round(metrics.screenToInterviewRate * 100) / 100,
      interviews_completed: metrics.interviewsCompleted,
      interview_to_offer_rate_pct: Math.round(metrics.interviewToOfferRate * 100) / 100,
      offers_received: metrics.offersReceived,
      primary_bottleneck: metrics.primaryBottleneck,
      recommended_action: metrics.recommendedAction,
    },
    { onConflict: 'week_ending' }
  )

  if (error) throw error
}
