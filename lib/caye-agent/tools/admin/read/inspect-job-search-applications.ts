import 'server-only'
import type { Tool } from '../../types'
import { runJobSearchInspection } from '@/app/api/caye/job-search-inspect/route'

/**
 * Founder-only, no-submission inspection of prepared job applications.
 *
 * This deliberately bypasses the generic trigger_cron surface: inspection
 * only reads public ATS form metadata, resolves fields from verified founder
 * facts/artifacts, and writes internal readiness/blocker state. It cannot
 * submit an application or contact an employer, so asking the founder for a
 * second confirmation would be UI friction rather than a safety control.
 */
export const inspectJobSearchApplications: Tool<Record<string, never>> = {
  name: 'inspect_job_search_applications',
  description:
    'Inspect the founder job-search applications that are currently NEEDS_HUMAN. Call this immediately when the founder asks to inspect job applications, discover Greenhouse required fields, resolve known application questions, show unresolved questions/options, or check submission readiness. Do not ask for confirmation before calling this tool. It cannot submit applications or contact employers.',
  risk: 'read',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      const result = await runJobSearchInspection()
      return { ok: true, data: result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not inspect job-search applications' }
    }
  },
}
