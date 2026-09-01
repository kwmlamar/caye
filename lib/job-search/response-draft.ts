/**
 * Job-search response loop — compose a routine recruiter reply or check-in
 * follow-up.
 *
 * Draft-only: this never sends anything (see founder-mail.ts /
 * send_recruiter_reply for the gated send path). Templates are
 * deliberately conservative and use ONLY verified profile facts
 * (full name, verified contact email/phone) plus the public company/title
 * already on the application — never an inferred or fabricated claim about
 * availability, compensation, or work authorization. isRoutineReplyCategory
 * is re-checked here (not just by the caller) so this function fails
 * closed even if a future caller forgets the check.
 *
 * Two modes, chosen by what's actually pending on the application:
 *  - REPLY: the most recent followup is an unanswered inbound message in a
 *    routine category (recruiter_interest / screen_request / scheduling /
 *    additional_information) — draft a reply to it.
 *  - FOLLOW-UP: the most recent followup is an unsent `scheduled_followup`
 *    marker written by lib/job-search/followup-scheduler.ts (silence after
 *    submission or after our own last message) — draft a short check-in,
 *    but ONLY if there is a real prior inbound contact to thread it to. A
 *    cold ATS submission with no human reply ever has no address to nudge
 *    and is reported back as needing a manual channel instead.
 */
import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { getActiveProfile } from './profile'
import { isRoutineReplyCategory, type ResponseClassification } from './response-classification'

export type RecruiterReplyDraft = {
  applicationId: string
  to: string
  subject: string
  body: string
  category: ResponseClassification | 'scheduled_followup'
  replyToMessageId: string | null
}

export type DraftRecruiterReplyResult =
  | { ok: true; draft: RecruiterReplyDraft }
  | { ok: false; reason: string; category?: ResponseClassification | 'scheduled_followup' }

type FollowupRow = { followup_type: string; direction: string; source_email_ref: string | null; note: string | null; sent_at: string | null }

function contactFromNote(note: string | null): string | null {
  const to = (note ?? '').split(':')[0]?.trim()
  return to && to.includes('@') ? to : null
}

function replyTargetFromRef(ref: string | null): string | null {
  return ref?.startsWith('zoho:') ? ref.slice('zoho:'.length) : null
}

function replyTemplate(category: ResponseClassification, params: { fullName: string; company: string; title: string; contactEmail: string | null; contactPhone: string | null }): string {
  const sign = [params.fullName, params.contactEmail, params.contactPhone].filter(Boolean).join('\n')
  switch (category) {
    case 'recruiter_interest':
      return `Thanks for reaching out about the ${params.title} role at ${params.company} — I'm interested and would love to learn more. What would be a good next step?\n\n${sign}`
    case 'screen_request':
      return `Thanks for the note — happy to do a screening call for the ${params.title} role. Could you share a couple of time options, or a scheduling link?\n\n${sign}`
    case 'scheduling':
      return `Thanks — happy to find a time. Could you share a scheduling link or a couple of windows that work on your end, and I'll confirm?\n\n${sign}`
    case 'additional_information':
      return `Thanks for following up on the ${params.title} application at ${params.company}. Let me know exactly which document(s) you still need and I'll get them right over.\n\n${sign}`
    default:
      throw new Error(`No routine template for category: ${category}`)
  }
}

function followupTemplate(params: { fullName: string; company: string; title: string; contactEmail: string | null; contactPhone: string | null }): string {
  const sign = [params.fullName, params.contactEmail, params.contactPhone].filter(Boolean).join('\n')
  return `Hi — following up on the ${params.title} role at ${params.company}. Still very interested and wanted to check in on where things stand.\n\n${sign}`
}

async function loadContext(applicationId: string) {
  const supabase = createServiceClient()
  const [{ data: application }, { data: followups }] = await Promise.all([
    supabase
      .from('job_search_applications')
      .select('id, status, candidate:job_search_candidates(company,title)')
      .eq('id', applicationId)
      .maybeSingle(),
    supabase
      .from('job_search_followups')
      .select('followup_type, direction, source_email_ref, note, sent_at')
      .eq('application_id', applicationId)
      .order('created_at', { ascending: false })
      .limit(50),
  ])
  return { application, followups: (followups ?? []) as FollowupRow[] }
}

export async function draftRecruiterReply(applicationId: string): Promise<DraftRecruiterReplyResult> {
  const { application, followups } = await loadContext(applicationId)
  if (!application) return { ok: false, reason: 'No such application' }
  if (!followups.length) return { ok: false, reason: 'No recruiter activity on this application to reply to' }

  const profile = await getActiveProfile()
  if (!profile || profile.status !== 'verified' || !profile.contactEmail) {
    return { ok: false, reason: 'Founder profile is not verified with contact details yet — cannot draft a reply that signs your name' }
  }

  const candidate = Array.isArray(application.candidate) ? application.candidate[0] : application.candidate
  const company = candidate?.company ?? 'the company'
  const title = candidate?.title ?? 'the role'
  const facts = { fullName: profile.fullName ?? '', company, title, contactEmail: profile.contactEmail, contactPhone: profile.contactPhone }

  const latest = followups[0]

  if (latest.direction === 'inbound') {
    const category = latest.followup_type as ResponseClassification
    if (!isRoutineReplyCategory(category)) {
      return { ok: false, reason: `"${category}" requires your judgment — Caye cannot draft this automatically`, category }
    }
    const to = contactFromNote(latest.note)
    if (!to) return { ok: false, reason: 'Could not determine a recipient address from the inbound message', category }
    return {
      ok: true,
      draft: {
        applicationId, to, subject: `Re: ${title} at ${company}`,
        body: replyTemplate(category, facts), category,
        replyToMessageId: replyTargetFromRef(latest.source_email_ref),
      },
    }
  }

  if (latest.followup_type === 'scheduled_followup' && !latest.sent_at) {
    const priorInbound = followups.find((f) => f.direction === 'inbound' && contactFromNote(f.note))
    if (!priorInbound) {
      return { ok: false, reason: 'No known recruiter contact on this application — this went out through an ATS with no human reply, so a check-in has nowhere to send. Needs a manual channel.', category: 'scheduled_followup' }
    }
    return {
      ok: true,
      draft: {
        applicationId, to: contactFromNote(priorInbound.note)!, subject: `Re: ${title} at ${company}`,
        body: followupTemplate(facts), category: 'scheduled_followup',
        replyToMessageId: replyTargetFromRef(priorInbound.source_email_ref),
      },
    }
  }

  return { ok: false, reason: 'Nothing pending on this application needs a reply right now' }
}
