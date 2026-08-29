import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../../types'

interface ExplainApplicationStatusInput {
  application_id: string
}

/**
 * CAY-194 founder UX: "Why is this application blocked?" / "What happened
 * with this failed application?" — reads the application row plus its most
 * recent execution attempt for full blocker/failure detail.
 */
export const explainApplicationStatus: Tool<ExplainApplicationStatusInput> = {
  name: 'explain_application_status',
  description:
    'Explain exactly why one job-search application is in its current state — its NEEDS_HUMAN/FAILED/SUBMISSION_UNCERTAIN reason plus the most recent execution attempt\'s blockers and preflight results. Call this for "why is this application blocked" / "what happened with X" questions, passing the application_id from list_applications_needing_review.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    properties: { application_id: { type: 'string', description: 'The job_search_applications.id to explain.' } },
    required: ['application_id'],
  },

  async execute(args) {
    try {
      const supabase = createServiceClient()
      const { data: application, error } = await supabase
        .from('job_search_applications')
        .select('id, status, needs_human_reason, failure_reason, dry_run, execution_attempt_count, candidate_id, job_search_candidates(company, title, apply_url)')
        .eq('id', args.application_id)
        .maybeSingle()
      if (error) return { ok: false, error: error.message }
      if (!application) return { ok: false, error: `No application found with id ${args.application_id}` }

      const { data: lastAttempt } = await supabase
        .from('job_search_execution_attempts')
        .select('attempt_number, provider, dry_run, outcome, blockers, preflight, domain_validations, failure_reason, confirmation_evidence, started_at, completed_at')
        .eq('application_id', args.application_id)
        .order('attempt_number', { ascending: false })
        .limit(1)
        .maybeSingle()

      const candidate = (application as unknown as { job_search_candidates: { company: string; title: string; apply_url: string } | null }).job_search_candidates

      return {
        ok: true,
        data: {
          application_id: application.id,
          status: application.status,
          company: candidate?.company ?? null,
          title: candidate?.title ?? null,
          needs_human_reason: application.needs_human_reason,
          failure_reason: application.failure_reason,
          dry_run: application.dry_run,
          execution_attempts: application.execution_attempt_count,
          last_attempt: lastAttempt ?? null,
        },
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not explain application status' }
    }
  },
}
