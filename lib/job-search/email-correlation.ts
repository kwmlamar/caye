import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { queueFounderFollowupReminder } from '@/lib/job-search/followup-policy'
import {
  classifyInboundEmail,
  resolveApplicationStatusAfterResponse,
  responsePriority,
  type InboundClassification,
} from '@/lib/job-search/response-classification'

export type RecruiterEmailCorrelationInput = {
  provider: 'zoho' | 'gmail'
  messageId: string
  emailSubject: string
  emailFrom: string
  emailSnippet: string
  receivedAt?: string | null
}

export type RecruiterEmailCorrelationResult =
  | { status: 'correlated'; applicationId: string; followupType: InboundClassification }
  | { status: 'duplicate'; applicationId: string | null }
  | { status: 'no_match' }

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export async function correlateRecruiterEmail(
  input: RecruiterEmailCorrelationInput,
): Promise<RecruiterEmailCorrelationResult> {
  const supabase = createServiceClient()
  const sourceRef = `${input.provider}:${input.messageId}`

  const { data: existing } = await supabase
    .from('job_search_followups')
    .select('application_id')
    .eq('source_email_ref', sourceRef)
    .maybeSingle()
  if (existing) return { status: 'duplicate', applicationId: existing.application_id ?? null }

  const { data: rows, error } = await supabase
    .from('job_search_applications')
    .select('id, status, submitted_at, priority_score, first_response_at, candidate:job_search_candidates(company,title,requisition_id)')
    .in('status', ['SUBMITTED', 'FOLLOWUP_DUE', 'SUBMISSION_UNCERTAIN', 'INTERVIEW'])
    .order('submitted_at', { ascending: false })
    .limit(250)
  if (error || !rows?.length) return { status: 'no_match' }

  const haystack = normalized(`${input.emailFrom} ${input.emailSubject} ${input.emailSnippet}`)
  const ranked = rows.map((row) => {
    const candidate = Array.isArray(row.candidate) ? row.candidate[0] : row.candidate
    const company = normalized(candidate?.company ?? '')
    const title = normalized(candidate?.title ?? '')
    const requisition = normalized(candidate?.requisition_id ?? '')
    let score = 0
    if (company && haystack.includes(company)) score += 5
    if (title && haystack.includes(title)) score += 2
    if (requisition && haystack.includes(requisition)) score += 4
    return { row, score }
  }).filter((item) => item.score >= 4).sort((a, b) => b.score - a.score)

  if (!ranked.length || (ranked[1] && ranked[1].score === ranked[0].score)) {
    return { status: 'no_match' }
  }

  const application = ranked[0].row
  const applicationId = application.id
  const combined = `${input.emailSubject}\n${input.emailSnippet}`
  const followupType = classifyInboundEmail(combined)
  const receivedAt = input.receivedAt ?? new Date().toISOString()

  const { error: insertError } = await supabase.from('job_search_followups').insert({
    application_id: applicationId,
    followup_type: followupType,
    response_classification: followupType === 'confirmation_check' ? null : followupType,
    direction: 'INBOUND',
    source_email_ref: sourceRef,
    subject: input.emailSubject.slice(0, 500),
    body: input.emailSnippet.slice(0, 4000),
    note: `${input.emailFrom}: ${input.emailSubject}`.slice(0, 500),
  })
  if (insertError?.code === '23505') return { status: 'duplicate', applicationId }
  if (insertError) throw new Error(`Could not record recruiter email: ${insertError.message}`)

  if (followupType === 'confirmation_check') {
    return { status: 'correlated', applicationId, followupType }
  }

  const nextStatus = resolveApplicationStatusAfterResponse(application.status, followupType)
  const update: Record<string, unknown> = {
    last_response_at: receivedAt,
    updated_at: new Date().toISOString(),
  }
  if (!application.first_response_at) update.first_response_at = receivedAt
  if (nextStatus && nextStatus !== application.status) update.status = nextStatus

  const priority = responsePriority(followupType)
  if (priority > Number(application.priority_score ?? 0)) update.priority_score = priority
  if (followupType === 'rejection') update.rejected_at = receivedAt
  if (followupType === 'offer') update.offer_at = receivedAt

  const { error: updateError } = await supabase
    .from('job_search_applications')
    .update(update)
    .eq('id', applicationId)
  if (updateError) throw new Error(`Could not update application from recruiter email: ${updateError.message}`)

  // This is an internal reminder only. It never sends mail; any eventual
  // external response still goes through the existing founder authority gates.
  try {
    await queueFounderFollowupReminder({
      applicationId,
      classification: followupType,
      receivedAt,
    })
  } catch (error) {
    console.warn('[job-search] could not queue founder follow-up reminder', {
      applicationId,
      classification: followupType,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return { status: 'correlated', applicationId, followupType }
}
