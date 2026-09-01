import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { classifyInboundEmail, type InboundClassification } from './response-classification'
import { logJobSearchEvent } from './events'

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

/**
 * followup_type -> application state effect. Reuses the EXISTING
 * ApplicationStatus enum (no duplicate state) for the categories that map
 * cleanly onto it; everything else lands on FOLLOWUP_DUE, the existing
 * "a human/Caye action is pending" status, distinguished for funnel
 * purposes by the followup row's own followup_type rather than a second
 * status column. `unknown` and `confirmation_check` never change status —
 * an unrecognized or autoresponder email is evidence, not a state change.
 */
const STATUS_BY_CLASSIFICATION: Partial<Record<InboundClassification, string>> = {
  rejection: 'REJECTED',
  offer: 'OFFER',
  interview_request: 'INTERVIEW',
  screen_request: 'FOLLOWUP_DUE',
  assessment: 'FOLLOWUP_DUE',
  scheduling: 'FOLLOWUP_DUE',
  additional_information: 'FOLLOWUP_DUE',
  recruiter_interest: 'FOLLOWUP_DUE',
}

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
    .select('id, status, submitted_at, first_response_at, candidate:job_search_candidates(company,title,requisition_id)')
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

  const matched = ranked[0].row
  const applicationId = matched.id
  const combined = `${input.emailSubject}\n${input.emailSnippet}`
  const followupType = classifyInboundEmail(combined)
  const receivedAt = input.receivedAt ?? new Date().toISOString()

  const { error: insertError } = await supabase.from('job_search_followups').insert({
    application_id: applicationId,
    followup_type: followupType,
    source_email_ref: sourceRef,
    direction: 'inbound',
    note: `${input.emailFrom}: ${input.emailSubject}`.slice(0, 500),
  })
  if (insertError?.code === '23505') return { status: 'duplicate', applicationId }
  if (insertError) throw new Error(`Could not record recruiter email: ${insertError.message}`)

  // A pure autoresponder ack is evidence, not a human response: no status
  // change, no priority bump, no response-latency timestamp.
  if (followupType !== 'confirmation_check') {
    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      last_response_at: receivedAt,
    }
    if (!matched.first_response_at) update.first_response_at = receivedAt

    const nextStatus = STATUS_BY_CLASSIFICATION[followupType]
    if (nextStatus) update.status = nextStatus
    if (nextStatus === 'REJECTED') update.rejected_at = receivedAt
    if (nextStatus === 'OFFER') update.offer_at = receivedAt
    // A recruiter reaching out with genuine interest and no concrete next
    // step yet is the highest-leverage moment to not sit on — surface it.
    if (followupType === 'recruiter_interest') update.priority = 'high'

    await supabase.from('job_search_applications').update(update).eq('id', applicationId)

    await logJobSearchEvent({
      eventType: 'application_response_classified',
      entityType: 'application',
      entityId: applicationId,
      payload: { followupType, previousStatus: matched.status, nextStatus: nextStatus ?? matched.status },
    })
  }

  return { status: 'correlated', applicationId, followupType }
}
