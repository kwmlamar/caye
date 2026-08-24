import 'server-only'
import { runOutreachAutosendScan } from '@/app/api/caye/outreach-autosend-scan/route'
import { runOutreachSourcingScan } from '@/app/api/caye/outreach-sourcing-scan/route'
import type { Tool } from '../types'

interface RunOutreachInput { operation?: 'autosend' | 'sourcing' | 'both' }

/**
 * Routine execution, not a policy change. The called jobs retain their own
 * deterministic pause, cap, lead-claim, validation, and idempotency guards.
 */
export const runOutreach: Tool<RunOutreachInput> = {
  name: 'run_outreach',
  description: 'Run authorized outreach work now when the owner asks. Use autosend to process eligible leads, sourcing to replenish a constrained pool, or both. This does not change targeting, send limits, or pause state, and the underlying jobs still enforce every policy guard. Report the real result after it runs; do not ask for an extra confirmation for routine work.',
  risk: 'low', roles: ['owner', 'founder'], modes: ['back-office'],
  inputSchema: { type: 'object', properties: { operation: { type: 'string', enum: ['autosend', 'sourcing', 'both'] } } },
  async execute(args) {
    const operation = args.operation ?? 'autosend'
    const sourcing = operation === 'sourcing' || operation === 'both'
      ? await runOutreachSourcingScan()
      : null
    const autosend = operation === 'autosend' || operation === 'both'
      ? await runOutreachAutosendScan()
      : null
    return { ok: true, data: { operation, sourcing, autosend } }
  },
}
