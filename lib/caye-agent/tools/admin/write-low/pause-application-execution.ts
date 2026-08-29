import 'server-only'
import { setEmergencyPaused } from '@/lib/job-search/execution/rollout'
import type { Tool } from '../../types'

interface PauseInput {
  reason?: string
}

/**
 * CAY-194: the "emergency pause" the issue's rollout-controls section
 * requires. Low-risk/immediate by design — same asymmetry as
 * pause_job_search (CAY-192): stopping a consequential action is always
 * safe to do without a confirmation round-trip; only re-enabling one is
 * gated (see enable-application-automation.ts).
 */
export const pauseApplicationExecution: Tool<PauseInput> = {
  name: 'pause_application_execution',
  description: 'Emergency-pause real ATS application execution immediately. Applications already PREPARED stay PREPARED; no new execution attempt starts until resumed. Call this for "pause automatic applications" / "stop applying" type requests.',
  risk: 'low',
  roles: ['founder'],
  modes: ['admin-shell', 'back-office'],
  inputSchema: {
    type: 'object',
    properties: { reason: { type: 'string', description: 'Optional reason, for the audit log.' } },
  },

  async execute(args) {
    try {
      await setEmergencyPaused(true, 'founder', args.reason)
      return { ok: true, data: { emergency_paused: true } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not pause application execution' }
    }
  },
}
