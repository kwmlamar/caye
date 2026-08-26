import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { canOutreachRecover } from './outreach-safety-recovery'
import type { OutreachOperationalStatus } from './outreach-operational-status'

function status(patch: Partial<OutreachOperationalStatus> = {}): OutreachOperationalStatus {
  return {
    workspaceId: 'workspace-1', timezone: 'UTC', enabled: true, paused: true,
    pause: { paused: true, source: 'bounce_safety', reason: 'threshold', pausedAt: '2026-08-25T10:00:00Z', generation: 'generation-1', activeSafetyCondition: null, disposition: 'safety_recovery_not_supported' },
    schedule: { sourcing: '', autosend: '', nextRunAt: null }, lastScan: { ranAt: null, succeeded: null, summary: null, error: null }, lastSourcing: { ranAt: null, succeeded: null, summary: null, error: null },
    sendsToday: { sent: 0, dailyLimit: 50, remaining: 50, firstTouch: 0, followups: 0, firstTouchTarget: 50, firstTouchRemaining: 50 }, sendsThisMonth: { firstTouch: 0, followups: 0, total: 0 },
    queue: { pendingDrafts: 0, stalled: 0, sourcingJobs: 0 }, sourcing: { availableCandidates: 0, cooldownCandidates: 0, lastFound: null, lastQualified: null, lastRejected: null, lastDuplicates: null },
    provider: { connected: true, healthy: true, kind: 'email', lastError: null }, blockers: [], reasonNoOutreach: null, telemetryComplete: true,
    ...patch,
  }
}

const handled = { id: 'bounce-1', inbound_message_id: 'inbound-1', recipient_email: 'prospect@example.test', recipient_suppressed_at: '2026-08-25T10:01:00Z', attribution_status: 'outbound_attributed' }

describe('deterministic outreach safety recovery policy', () => {
  it('allows recovery only after the window clears and every triggering recipient is handled', () => {
    expect(canOutreachRecover({ status: status(), bounces: [handled], evaluatedAt: '2026-08-26T10:00:00Z' })).toMatchObject({ allowed: true, blockers: [] })
  })

  it('denies an active threshold and provider safety blocker', () => {
    const active = status({ pause: { ...status().pause, activeSafetyCondition: 'bounce_threshold', disposition: 'safety_active' } })
    expect(canOutreachRecover({ status: active, bounces: [handled], evaluatedAt: 'now' }).blockers).toContain('active_bounce_threshold')
    const provider = status({ pause: { ...status().pause, activeSafetyCondition: 'provider_unhealthy', disposition: 'safety_active' } })
    expect(canOutreachRecover({ status: provider, bounces: [handled], evaluatedAt: 'now' }).blockers).toContain('active_provider_unhealthy')
  })

  it('fails closed for historical/ambiguous evidence and does not manufacture recovery proof', () => {
    const decision = canOutreachRecover({ status: status(), bounces: [{ ...handled, inbound_message_id: null, recipient_email: null, recipient_suppressed_at: null, attribution_status: 'legacy_unknown' }], evaluatedAt: 'now' })
    expect(decision).toMatchObject({ allowed: false })
    expect(decision.blockers).toContain('unresolved_bounce_evidence')
  })
})
