/**
 * Job-search operator (#192) — daily founder summary.
 *
 * Feeds the existing founder UX with pipeline counts plus the measured
 * application-response funnel. Recruiter responses are surfaced here rather
 * than through a second CRM or notification system.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getJobResponseFunnel, type JobResponseFunnel } from '@/lib/job-search/funnel-metrics'
import type { ResponseClassification } from '@/lib/job-search/response-classification'

export type ImportantJobResponse = {
  applicationId: string
  classification: ResponseClassification
  subject: string | null
  receivedAt: string
}

export type DailySummary = {
  businessDate: string
  sourced: number
  qualified: number
  needsHuman: number
  submitted: number
  rejected: number
  rejectionBreakdown: Record<string, number>
  paused: boolean
  responseFunnel: JobResponseFunnel
  importantResponses: ImportantJobResponse[]
}

const IMPORTANT_RESPONSE_TYPES: ResponseClassification[] = [
  'offer',
  'interview_request',
  'screen_request',
  'recruiter_interest',
  'assessment',
  'scheduling',
  'additional_information',
]

export async function getDailySummary(date = new Date()): Promise<DailySummary> {
  const supabase = createServiceClient()
  const todayStart = new Date(date)
  todayStart.setUTCHours(0, 0, 0, 0)
  const todayStartISO = todayStart.toISOString()

  const [
    { data: candidatesToday },
    { data: applicationsToday },
    { data: settingsRow },
    { data: importantRows },
    responseFunnel,
  ] = await Promise.all([
    supabase
      .from('job_search_candidates')
      .select('status, hard_block_reason')
      .gte('discovered_at', todayStartISO),
    supabase
      .from('job_search_applications')
      .select('status')
      .gte('prepared_at', todayStartISO),
    supabase.from('job_search_settings').select('paused').eq('id', true).maybeSingle(),
    supabase
      .from('job_search_followups')
      .select('application_id, response_classification, subject, created_at')
      .eq('direction', 'INBOUND')
      .in('response_classification', IMPORTANT_RESPONSE_TYPES)
      .order('created_at', { ascending: false })
      .limit(10),
    getJobResponseFunnel(),
  ])

  const candidates = candidatesToday ?? []
  const applications = applicationsToday ?? []

  const rejectionBreakdown: Record<string, number> = {}
  let rejected = 0
  for (const row of candidates) {
    if (row.status === 'REJECTED') {
      rejected += 1
      const key = row.hard_block_reason ?? 'below_fit_threshold'
      rejectionBreakdown[key] = (rejectionBreakdown[key] ?? 0) + 1
    }
  }

  const importantResponses: ImportantJobResponse[] = (importantRows ?? []).flatMap((row) => {
    if (!row.response_classification || !row.created_at) return []
    return [{
      applicationId: row.application_id,
      classification: row.response_classification as ResponseClassification,
      subject: row.subject ?? null,
      receivedAt: row.created_at,
    }]
  })

  return {
    businessDate: todayStart.toISOString().slice(0, 10),
    sourced: candidates.length,
    qualified: candidates.filter((c) => c.status === 'QUEUED').length,
    needsHuman: applications.filter((a) => a.status === 'NEEDS_HUMAN').length,
    submitted: applications.filter((a) => a.status === 'SUBMITTED').length,
    rejected,
    rejectionBreakdown,
    paused: settingsRow?.paused ?? true,
    responseFunnel,
    importantResponses,
  }
}
