import 'server-only'
import { setDryRun } from '@/lib/job-search/execution/rollout'
import type { Tool } from '../../types'

/** CAY-194: turning dry-run ON is safety-positive — low-risk, immediate. Turning it OFF is the consequential direction; see disable-dry-run-mode.ts (gated). */
export const enableDryRunMode: Tool<Record<string, never>> = {
  name: 'enable_dry_run_mode',
  description: 'Turn dry-run mode ON for real ATS application execution — proves readiness (destination validation, field discovery, answer resolution) without ever submitting for real. Call this for "enable dry run" / "turn on dry run".',
  risk: 'low',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      await setDryRun(true, 'founder')
      return { ok: true, data: { dry_run: true } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not enable dry-run mode' }
    }
  },
}
