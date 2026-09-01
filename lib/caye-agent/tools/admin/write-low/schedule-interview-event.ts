import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { createFounderInterviewEvent } from '@/lib/job-search/founder-calendar'
import { logJobSearchEvent } from '@/lib/job-search/events'
import type { Tool } from '../../types'

type Input = { application_id: string; start_at: string; duration_minutes?: number; notes?: string }

/**
 * LOW-RISK: writes a PERSONAL (no-attendee) event to the founder's own
 * calendar. No email goes out to the recruiter — this only requires the
 * founder to have already confirmed a concrete time with them (by hand, or
 * via a sent reply). Requirement 5 ("integrate existing calendar capability
 * where available") deliberately stops at "create the event," not "auto-
 * parse a date out of free-text email and commit to it" — see
 * lib/job-search/founder-calendar.ts's doc comment for why.
 */
export const scheduleInterviewEventTool: Tool<Input> = {
  name: 'schedule_interview_event',
  description:
    'Create a personal calendar event on your own calendar for an interview/screen once you\'ve confirmed a concrete time with the recruiter. Does not invite or notify the recruiter — just blocks your calendar and marks the application INTERVIEW. Use after a time is actually agreed, not to guess one from an email.',
  risk: 'low',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    required: ['application_id', 'start_at'],
    properties: {
      application_id: { type: 'string' },
      start_at: { type: 'string', description: 'ISO datetime for the start of the interview/screen.' },
      duration_minutes: { type: 'number', description: 'Defaults to 30.' },
      notes: { type: 'string' },
    },
  },

  async execute(args) {
    try {
      const supabase = createServiceClient()
      const { data: application, error } = await supabase
        .from('job_search_applications')
        .select('id, status, candidate:job_search_candidates(company,title)')
        .eq('id', args.application_id)
        .maybeSingle()
      if (error || !application) return { ok: false, error: error?.message ?? 'No such application' }

      const candidate = Array.isArray(application.candidate) ? application.candidate[0] : application.candidate
      const title = `Interview — ${candidate?.title ?? 'role'} at ${candidate?.company ?? 'company'}`

      const eventId = await createFounderInterviewEvent({
        applicationId: args.application_id,
        title,
        startAt: args.start_at,
        durationMinutes: args.duration_minutes ?? 30,
        notes: args.notes ?? null,
      })

      await supabase
        .from('job_search_applications')
        .update({ status: 'INTERVIEW', updated_at: new Date().toISOString() })
        .eq('id', args.application_id)

      await logJobSearchEvent({
        eventType: 'application_interview_scheduled',
        entityType: 'application',
        entityId: args.application_id,
        payload: { eventId, startAt: args.start_at, durationMinutes: args.duration_minutes ?? 30 },
      })

      return { ok: true, data: { application_id: args.application_id, calendar_event_id: eventId, start_at: args.start_at } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not schedule the interview event' }
    }
  },
}
