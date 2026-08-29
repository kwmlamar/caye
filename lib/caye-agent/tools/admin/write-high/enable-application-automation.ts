import 'server-only'
import { setAutomationEnabled } from '@/lib/job-search/execution/rollout'
import type { Tool } from '../../types'

/**
 * CAY-194: the single flag that allows the executor to attempt real ATS
 * submissions at all (still further gated by dry_run defaulting true,
 * daily_submission_cap defaulting to 3, and the provider/employer
 * allowlists — see rollout.ts). Registered pre-wrapped with
 * gateAdminHighRisk in registry.ts, same pattern as set_workspace_autonomy:
 * this raw execute() only ever runs on the confirming (second) call.
 *
 * HIGH-risk for the same reason set_workspace_autonomy is: this is a real
 * expansion of autonomous, outward-facing action (a submission sent to a
 * real employer's ATS in Lamar's name, under his real resume) rather than
 * an internal flag flip. An accidental enable is not reversible after the
 * fact for whatever gets submitted in the meantime.
 */
export const enableApplicationAutomation: Tool<Record<string, never>> = {
  name: 'enable_application_automation',
  description:
    'Enable real ATS application-submission automation. HIGH-RISK — this is what allows the executor to actually submit applications (still bounded by dry_run, daily_submission_cap, and provider/employer allowlists). Confirmation is enforced in code: the first call only stages the change, then relay the summary and call again with identical arguments once the founder confirms in a NEW message.',
  risk: 'high',
  roles: ['founder'],
  modes: ['admin-shell'],
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      await setAutomationEnabled(true, 'founder')
      return { ok: true, data: { automation_enabled: true } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not enable application automation' }
    }
  },
}
