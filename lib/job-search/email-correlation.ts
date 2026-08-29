import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'

export type RecruiterEmailCorrelationInput = {
  provider: 'zoho' | 'gmail'
  messageId: string
  emailSubject: string
  emailFrom: string
  emailSnippet: string
  receivedAt?: string | null
}

export type RecruiterEmailCorrelationResult =
  | { status: 'correlated'; applicationId: string; followupType: 'confirmation_check' | 'recruiter_reply' | 'interview_request' }
  | { status: 'duplicate'; applicationId: string | null }
  | { status: 'no_match' }

const INTERVIEW = /\b(interview|screen(?:ing)? call|phone screen|technical screen|schedule (?:a )?(?:call|meeting)|availability)\b/i
const CONFIRMATION = /\b(application (?:was |has been )?(?:received|submitted)|thanks? for applying|application confirmation)\b/i

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
    .select('id, status, submitted_at, candidate:job_search_candidates(company,title,requisition_id)')
    .in('status', ['SUBMITTED', 'FOLLOWUP_DUE', 'SUBMISSION_UNCERTAIN'])
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

  const applicationId = ranked[0].row.id
  const combined = `${input.emailSubject}\n${input.emailSnippet}`
  const followupType = INTERVIEW.test(combined)
    ? 'interview_request'
    : CONFIRMATION.test(combined)
      ? 'confirmation_check'
      : 'recruiter_reply'

  const { error: insertError } = await supabase.from('job_search_followups').insert({
    application_id: applicationId,
    followup_type: followupType,
    source_email_ref: sourceRef,
    note: `${input.emailFrom}: ${input.emailSubject}`.slice(0, 500),
  })
  if (insertError?.code === '23505') return { status: 'duplicate', applicationId }
  if (insertError) throw new Error(`Could not record recruiter email: ${insertError.message}`)

  if (followupType !== 'confirmation_check') {
    await supabase.from('job_search_applications')
      .update({ status: 'FOLLOWUP_DUE', updated_at: new Date().toISOString() })
      .eq('id', applicationId)
  }
  return { status: 'correlated', applicationId, followupType }
}
