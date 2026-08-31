import 'server-only'
import { setDryRun } from '@/lib/job-search/execution/rollout'
import type { Tool } from '../../types'

/**
 * CAY-194: the literal "take the training wheels off" action. Turning
 * dry_run off is what allows a real submission to actually reach an ATS
 * (still requires automation_enabled=true and emergency_paused=false —
 * see rollout.ts). HIGH-risk, gateAdminHighRisk-wrapped in registry.ts,
 * same confirmation mechanism as enable-application-automation.ts.
 */
export const disableDryRunMode: Tool<Record<string, never>> = {
  name: 'disable_dry_run_mode',
  description:
    'Turn dry-run mode OFF — the change that allows a real submission to actually reach an ATS (still requires automation to be enabled). HIGH-RISK — confirmation is enforced in code: the first call only stages the change, then relay the summary and call again with identical arguments once the founder confirms in a NEW message.',
  risk: 'high',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      await setDryRun(false, 'founder')
      return { ok: true, data: { dry_run: false } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not disable dry-run mode' }
    }
  },
}
