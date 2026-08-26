import 'server-only'
import { runOutreachAutosendScan } from '@/app/api/caye/outreach-autosend-scan/route'
import { runOutreachSourcingScan } from '@/app/api/caye/outreach-sourcing-scan/route'
import { getOutreachOperationalStatus } from '@/lib/outreach-operational-status'
import { resumeOwnerPausedOutreach } from '@/lib/outreach-pause-control'
import { recoverOutreachSafetyIfAllowed } from '@/lib/outreach-safety-recovery'
import type { Tool } from '../types'

export const recoverOutreachOperations: Tool<Record<string, never>> = {
  name: 'recover_outreach_operations',
  description: 'Recover normal outreach operations after an owner asks why sending is paused or asks to resume toward the configured first-touch target. Inspect the live blocker first. Resume an owner-created pause, or a bounce safety pause only after deterministic recipient-suppression evidence and a final database revalidation permit it. Never override active safety, an unknown pause, a disabled workspace, daily caps, targeting rules, suppression, or idempotency. When recovery is permitted, run the existing sourcing and autosend jobs and report their actual result in this turn.',
  risk: 'low', roles: ['owner', 'founder'], modes: ['back-office'], inputSchema: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const before = await getOutreachOperationalStatus(ctx.workspaceId)
    if (!before.enabled) return { ok: true, data: { recovered: false, blocker: 'outreach_disabled', status: before } }
    let safetyRecovery: Awaited<ReturnType<typeof recoverOutreachSafetyIfAllowed>> | null = null
    if (before.pause.source === 'bounce_safety') {
      safetyRecovery = await recoverOutreachSafetyIfAllowed(ctx.workspaceId, ctx.callerRole as 'owner' | 'founder')
      if (!safetyRecovery.recovered) {
        return { ok: true, data: {
          recovered: false, blocker: safetyRecovery.decision.blockers[0] ?? 'bounce_safety_recovery_denied',
          recovery: safetyRecovery.decision, pause: before.pause, status: before,
        } }
      }
    }
    if (!safetyRecovery && (before.pause.disposition === 'safety_active' || before.pause.disposition === 'safety_recovery_not_supported' || before.pause.disposition === 'unknown_blocked')) {
      return { ok: true, data: { recovered: false, blocker: before.pause.disposition, pause: before.pause, status: before } }
    }
    if (before.pause.disposition === 'owner_resumable') {
      // The registry role gate above admits only owner/founder callers.
      const resumed = await resumeOwnerPausedOutreach(ctx.workspaceId, ctx.callerRole as 'owner' | 'founder')
      if (resumed.disposition !== 'running') return { ok: true, data: { recovered: false, blocker: resumed.disposition, pause: resumed, status: before } }
    }
    const sourcing = await runOutreachSourcingScan()
    const autosend = await runOutreachAutosendScan()
    return { ok: true, data: { recovered: true, resumed: before.pause.disposition === 'owner_resumable' || safetyRecovery?.recovered === true, recovery: safetyRecovery?.decision ?? null, sourcing, autosend, status: await getOutreachOperationalStatus(ctx.workspaceId) } }
  },
}
