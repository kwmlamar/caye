import 'server-only'
import { setAutomationEnabled } from '@/lib/job-search/execution/rollout'
import type { Tool } from '../../types'

/** CAY-194: turning automation OFF is safety-positive — low-risk, immediate. Turning it ON is gated; see write-high/enable-application-automation.ts. */
export const disableApplicationAutomation: Tool<Record<string, never>> = {
  name: 'disable_application_automation',
  description: 'Turn real ATS application-submission automation OFF immediately. Call this for "turn off automatic applications" / "stop submitting applications for me" type requests.',
  risk: 'low',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      await setAutomationEnabled(false, 'founder')
      return { ok: true, data: { automation_enabled: false } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not disable application automation' }
    }
  },
}
