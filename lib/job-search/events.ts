/**
 * Job-search operator (#192) — append-only audit log writer.
 *
 * Every phase (sourcing, scoring, artifact generation, answer resolution,
 * submit attempt, failure, escalation) calls logJobSearchEvent so
 * job_search_events is a complete trail per the issue's "maintain an audit
 * trail for every sourced role, score, generated artifact, answer, submit
 * action, failure, and escalation" requirement. Never updates or deletes
 * existing rows.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'

export type JobSearchEventType =
  | 'candidate_discovered'
  | 'candidate_scored'
  | 'candidate_rejected'
  | 'candidate_queued'
  | 'candidate_needs_human'
  | 'application_prepared'
  | 'application_artifact_generated'
  | 'application_answer_resolved'
  | 'application_answer_needs_human'
  | 'application_submit_attempted'
  | 'application_needs_human'
  | 'application_submitted'
  | 'application_failed'
  | 'application_response_classified'
  | 'application_reply_drafted'
  | 'application_reply_sent'
  | 'application_interview_scheduled'
  | 'application_followup_scheduled'
  | 'application_ghost_detected'
  | 'run_started'
  | 'run_completed'
  | 'run_failed'
  | 'settings_changed'

export type JobSearchEntityType =
  | 'candidate'
  | 'application'
  | 'profile_fact'
  | 'resume_variant'
  | 'artifact'
  | 'run'
  | 'settings'

export async function logJobSearchEvent(params: {
  eventType: JobSearchEventType
  entityType: JobSearchEntityType
  entityId?: string | null
  payload?: Record<string, unknown>
  createdBy?: string
}): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase.from('job_search_events').insert({
    event_type: params.eventType,
    entity_type: params.entityType,
    entity_id: params.entityId ?? null,
    payload: params.payload ?? {},
    created_by: params.createdBy ?? 'system',
  })
  if (error) {
    // Audit logging must never crash the pipeline it's observing, but it
    // must not fail silently either — surface it to server logs.
    console.error('[job-search] failed to write audit event', params.eventType, error.message)
  }
}
