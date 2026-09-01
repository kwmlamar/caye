/**
 * Job-search response loop — periodic sweep that (a) flags applications
 * gone quiet for long enough to warrant a check-in, capped so we never
 * nudge a recruiter into annoyance, and (b) marks an application ghosted
 * once follow-ups are exhausted and enough time has passed with no reply.
 *
 * This module never sends anything itself — it only writes an unsent
 * `scheduled_followup` marker row (direction='outbound', sent_at=null).
 * lib/job-search/response-draft.ts turns that marker into actual reply
 * text, and the send_recruiter_reply admin tool (HIGH-RISK, confirmed) is
 * what actually contacts anyone. Keeping "decide a follow-up is due" and
 * "send a message to a real person" as separate, separately-authorized
 * steps is deliberate — see lib/job-search/CLAUDE.md's "a draft is not a
 * send" product invariant (CLAUDE.md).
 */
import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { isRoutineReplyCategory, type ResponseClassification } from './response-classification'
import { logJobSearchEvent } from './events'

/** Days of silence after submission (or after our own last message) before the FIRST automated check-in is flagged. */
const FIRST_FOLLOWUP_AFTER_DAYS = 10
/** Minimum gap between consecutive automated check-ins. */
const FOLLOWUP_GAP_DAYS = 7
/** Never flag more than this many automated check-ins for one application — the anti-annoyance cap. */
const MAX_AUTO_FOLLOWUPS = 2
/** Days of total silence, with follow-ups exhausted, before we call it ghosted rather than "still waiting". */
const GHOST_AFTER_DAYS = 35

const DAY_MS = 86_400_000

type ApplicationRow = {
  id: string
  status: string
  submitted_at: string | null
  last_response_at: string | null
  ghosted_at: string | null
}

type FollowupRow = { followup_type: string; direction: string; sent_at: string | null; created_at: string }

export type FollowupSweepResult = { flagged: number; ghosted: number; skipped: number }

export async function runFollowupSweep(): Promise<FollowupSweepResult> {
  const supabase = createServiceClient()
  const result: FollowupSweepResult = { flagged: 0, ghosted: 0, skipped: 0 }

  const { data: applications } = await supabase
    .from('job_search_applications')
    .select('id, status, submitted_at, last_response_at, ghosted_at')
    .in('status', ['SUBMITTED', 'FOLLOWUP_DUE'])
    .is('ghosted_at', null)
    .not('submitted_at', 'is', null)
    .limit(500)

  for (const application of (applications ?? []) as ApplicationRow[]) {
    const { data: followups } = await supabase
      .from('job_search_followups')
      .select('followup_type, direction, sent_at, created_at')
      .eq('application_id', application.id)
      .order('created_at', { ascending: true })
    const rows = (followups ?? []) as FollowupRow[]

    const outboundNudges = rows.filter((f) => f.followup_type === 'scheduled_followup' && f.direction === 'outbound')
    const latest = rows[rows.length - 1]
    const lastActivityAt = application.last_response_at ?? application.submitted_at!
    const daysSinceActivity = (Date.now() - new Date(lastActivityAt).getTime()) / DAY_MS

    if (outboundNudges.length >= MAX_AUTO_FOLLOWUPS && daysSinceActivity >= GHOST_AFTER_DAYS) {
      await supabase.from('job_search_applications')
        .update({ ghosted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', application.id)
      await logJobSearchEvent({ eventType: 'application_ghost_detected', entityType: 'application', entityId: application.id, payload: { daysSinceActivity: Math.round(daysSinceActivity) } })
      result.ghosted++
      continue
    }

    // An unresolved inbound message in a routine reply category should be
    // answered directly (draftRecruiterReply's REPLY mode), not buried
    // under a generic check-in — skip the sweep for it.
    if (latest?.direction === 'inbound' && isRoutineReplyCategory(latest.followup_type as ResponseClassification)) {
      result.skipped++
      continue
    }
    // Already have an unsent check-in queued — don't stack another marker.
    if (latest?.followup_type === 'scheduled_followup' && latest.direction === 'outbound' && !latest.sent_at) {
      result.skipped++
      continue
    }
    if (outboundNudges.length >= MAX_AUTO_FOLLOWUPS) {
      result.skipped++
      continue
    }

    const minGapDays = outboundNudges.length === 0 ? FIRST_FOLLOWUP_AFTER_DAYS : FOLLOWUP_GAP_DAYS
    if (daysSinceActivity < minGapDays) {
      result.skipped++
      continue
    }

    await supabase.from('job_search_followups').insert({
      application_id: application.id,
      followup_type: 'scheduled_followup',
      direction: 'outbound',
      note: `Automated check-in due — ${Math.round(daysSinceActivity)} days of silence`,
    })
    if (application.status !== 'FOLLOWUP_DUE') {
      await supabase.from('job_search_applications')
        .update({ status: 'FOLLOWUP_DUE', updated_at: new Date().toISOString() })
        .eq('id', application.id)
    }
    await logJobSearchEvent({ eventType: 'application_followup_scheduled', entityType: 'application', entityId: application.id, payload: { nudgeNumber: outboundNudges.length + 1, daysSinceActivity: Math.round(daysSinceActivity) } })
    result.flagged++
  }

  return result
}
