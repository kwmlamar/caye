import 'server-only'
import { setJobSearchPaused } from '@/lib/job-search/settings'
import type { Tool } from '../../types'

interface PauseInput {
  reason?: string
}

/**
 * Low-risk (not gated via gateAdminHighRisk): pausing is safety-positive
 * and immediate by design — it only stops NEW application preparation
 * (application-executor.ts checks paused before creating/advancing an
 * application); sourcing/scoring keep running so the founder can still
 * see what's out there. "pause prevents new application execution" is a
 * regression test in lib/job-search/application-executor.test.ts.
 */
export const pauseJobSearch: Tool<PauseInput> = {
  name: 'pause_job_search',
  description: 'Pause the job-search operator\'s application phase immediately. Sourcing/scoring keep running; no new applications get prepared until resumed. Call this when the founder says "pause applications" or similar.',
  risk: 'low',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    properties: { reason: { type: 'string', description: 'Optional reason, for the audit log.' } },
  },

  async execute(args) {
    try {
      await setJobSearchPaused(true, args.reason ?? 'Paused by founder request', 'founder')
      return { ok: true, data: { paused: true } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not pause job search' }
    }
  },
}
