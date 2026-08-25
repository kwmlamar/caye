import 'server-only'
import { runOutreachAutosendScan } from '@/app/api/caye/outreach-autosend-scan/route'
import { runOutreachSourcingScan } from '@/app/api/caye/outreach-sourcing-scan/route'
import { getOutreachOperationalStatus } from '@/lib/outreach-operational-status'
import { resumeOwnerPausedOutreach } from '@/lib/outreach-pause-control'
import type { Tool } from '../types'

export const recoverOutreachOperations: Tool<Record<string, never>> = {
  name: 'recover_outreach_operations',
  description: 'Recover normal outreach operations after an owner asks why sending is paused or asks to resume toward the configured first-touch target. Inspect the live blocker first. Resume only an owner-created pause; never override a bounce safety stop, an unknown pause, a disabled workspace, the daily cap, targeting rules, suppression, or idempotency. When recovery is permitted, run the existing sourcing and autosend jobs and report their actual result in this turn.',
  risk: 'low', roles: ['owner', 'founder'], modes: ['back-office'], inputSchema: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const before = await getOutreachOperationalStatus(ctx.workspaceId)
    if (!before.enabled) return { ok: true, data: { recovered: false, blocker: 'outreach_disabled', status: before } }
    if (before.pause.disposition === 'safety_active' || before.pause.disposition === 'safety_recovery_not_supported' || before.pause.disposition === 'unknown_blocked') {
      return { ok: true, data: { recovered: false, blocker: before.pause.disposition, pause: before.pause, status: before } }
    }
    if (before.pause.disposition === 'owner_resumable') {
      // The registry role gate above admits only owner/founder callers.
      const resumed = await resumeOwnerPausedOutreach(ctx.workspaceId, ctx.callerRole as 'owner' | 'founder')
      if (resumed.disposition !== 'running') return { ok: true, data: { recovered: false, blocker: resumed.disposition, pause: resumed, status: before } }
    }
    const sourcing = await runOutreachSourcingScan()
    const autosend = await runOutreachAutosendScan()
    return { ok: true, data: { recovered: true, resumed: before.pause.disposition === 'owner_resumable', sourcing, autosend, status: await getOutreachOperationalStatus(ctx.workspaceId) } }
  },
}
