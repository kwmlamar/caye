import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import type { Tool } from '../../types'

interface GetSubmissionEvidenceInput {
  application_id: string
}

/**
 * CAY-194 founder UX: "Show submission evidence for this application." —
 * never claims a submission unless job_search_execution_attempts actually
 * has a confirmation_evidence row backing it (see executor.ts — that
 * column is only ever populated by a provider that returned a verified
 * confirmation identifier).
 */
export const getApplicationSubmissionEvidence: Tool<GetSubmissionEvidenceInput> = {
  name: 'get_application_submission_evidence',
  description: 'Show the submission evidence (provider, confirmation id, resume artifact used, timestamp) for one job-search application, if it was actually submitted. Call this for "show me proof this was submitted" / "what confirmation do we have for X" questions.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    properties: { application_id: { type: 'string' } },
    required: ['application_id'],
  },

  async execute(args) {
    try {
      const supabase = createServiceClient()
      const { data: application, error } = await supabase
        .from('job_search_applications')
        .select('id, status, submitted_at, method')
        .eq('id', args.application_id)
        .maybeSingle()
      if (error) return { ok: false, error: error.message }
      if (!application) return { ok: false, error: `No application found with id ${args.application_id}` }

      const { data: submittedAttempt } = await supabase
        .from('job_search_execution_attempts')
        .select('attempt_number, provider, confirmation_evidence, resume_artifact_id, completed_at')
        .eq('application_id', args.application_id)
        .eq('outcome', 'submitted')
        .order('attempt_number', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (application.status !== 'SUBMITTED' || !submittedAttempt?.confirmation_evidence) {
        return {
          ok: true,
          data: { submitted: false, status: application.status, note: 'No submission evidence exists for this application — it has not been submitted.' },
        }
      }

      return {
        ok: true,
        data: {
          submitted: true,
          status: application.status,
          submitted_at: application.submitted_at,
          method: application.method,
          provider: submittedAttempt.provider,
          confirmation_evidence: submittedAttempt.confirmation_evidence,
          resume_artifact_id: submittedAttempt.resume_artifact_id,
        },
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read submission evidence' }
    }
  },
}
