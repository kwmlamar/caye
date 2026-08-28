import 'server-only'
import { setJobSearchPaused } from '@/lib/job-search/settings'
import type { Tool } from '../../types'

/**
 * Low-risk, matching pause_job_search: resuming only re-enables
 * application PREPARATION (which itself always lands at NEEDS_HUMAN in
 * this build — see application-executor.ts's doc comment). No automated
 * submission exists yet for a resume to unlock, so this doesn't need the
 * high-risk confirmation gate.
 */
export const resumeJobSearch: Tool<Record<string, never>> = {
  name: 'resume_job_search',
  description: 'Resume the job-search operator\'s application phase after a pause. Call this when the founder says "resume applications" / "unpause" or similar.',
  risk: 'low',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      await setJobSearchPaused(false, 'Resumed by founder request', 'founder')
      return { ok: true, data: { paused: false } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not resume job search' }
    }
  },
}
