import 'server-only'
import { setEmergencyPaused } from '@/lib/job-search/execution/rollout'
import type { Tool } from '../../types'

/**
 * CAY-194: clears the emergency pause only. This alone can never cause a
 * real submission — automation_enabled and dry_run are separate flags,
 * each gated by their own high-risk tool (enable-application-automation.ts,
 * disable-dry-run-mode.ts). Low-risk, mirrors resume_job_search's existing
 * "resuming this specific safety switch is safe because the other gates
 * still apply" reasoning from CAY-192.
 */
export const resumeApplicationExecution: Tool<Record<string, never>> = {
  name: 'resume_application_execution',
  description: 'Clear the emergency pause on real ATS application execution. Does NOT by itself enable automation or disable dry-run — those require separate, explicitly-confirmed tools. Call this for "resume automatic applications" after a prior emergency pause.',
  risk: 'low',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      await setEmergencyPaused(false, 'founder')
      return { ok: true, data: { emergency_paused: false } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not resume application execution' }
    }
  },
}
