import { isPositiveResponse, type ResponseClassification } from './response-classification'

export type JobResponseFunnel = {
  applications: number
  responses: number
  positiveResponses: number
  screens: number
  interviews: number
  offers: number
  rejections: number
  averageResponseLatencyHours: number | null
}

type ApplicationRow = {
  id: string
  submitted_at: string | null
  first_response_at: string | null
}

type FollowupRow = {
  application_id: string
  response_classification: ResponseClassification | null
  direction: string | null
}

export function calculateJobResponseFunnel(
  applications: ApplicationRow[],
  followups: FollowupRow[],
): JobResponseFunnel {
  const submitted = applications.filter((application) => application.submitted_at)
  const submittedIds = new Set(submitted.map((application) => application.id))
  const responses = new Set<string>()
  const positives = new Set<string>()
  const screens = new Set<string>()
  const interviews = new Set<string>()
  const offers = new Set<string>()
  const rejections = new Set<string>()

  for (const followup of followups) {
    if (!submittedIds.has(followup.application_id) || followup.direction !== 'INBOUND') continue
    const classification = followup.response_classification
    if (!classification) continue

    responses.add(followup.application_id)
    if (isPositiveResponse(classification)) positives.add(followup.application_id)
    if (classification === 'screen_request') screens.add(followup.application_id)
    if (classification === 'interview_request') interviews.add(followup.application_id)
    if (classification === 'offer') offers.add(followup.application_id)
    if (classification === 'rejection') rejections.add(followup.application_id)
  }

  const latencies = submitted.flatMap((application) => {
    if (!application.submitted_at || !application.first_response_at) return []
    const submittedAt = new Date(application.submitted_at).getTime()
    const respondedAt = new Date(application.first_response_at).getTime()
    const latency = respondedAt - submittedAt
    return Number.isFinite(latency) && latency >= 0 ? [latency / 3_600_000] : []
  })

  return {
    applications: submitted.length,
    responses: responses.size,
    positiveResponses: positives.size,
    screens: screens.size,
    interviews: interviews.size,
    offers: offers.size,
    rejections: rejections.size,
    averageResponseLatencyHours: latencies.length
      ? Math.round((latencies.reduce((sum, value) => sum + value, 0) / latencies.length) * 10) / 10
      : null,
  }
}

export async function getJobResponseFunnel(): Promise<JobResponseFunnel> {
  const { createServiceClient } = await import('@/lib/supabase-server')
  const supabase = createServiceClient()
  const [{ data: applications, error: applicationsError }, { data: followups, error: followupsError }] = await Promise.all([
    supabase
      .from('job_search_applications')
      .select('id, submitted_at, first_response_at')
      .not('submitted_at', 'is', null),
    supabase
      .from('job_search_followups')
      .select('application_id, response_classification, direction')
      .eq('direction', 'INBOUND')
      .not('response_classification', 'is', null),
  ])

  if (applicationsError) throw new Error(`Could not load job applications: ${applicationsError.message}`)
  if (followupsError) throw new Error(`Could not load recruiter responses: ${followupsError.message}`)

  return calculateJobResponseFunnel(
    (applications ?? []) as ApplicationRow[],
    (followups ?? []) as FollowupRow[],
  )
}
