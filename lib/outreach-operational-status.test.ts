import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { explainNoOutreach, startOfBusinessDay, startOfBusinessMonth, type OutreachOperationalStatus } from './outreach-operational-status'

function state(patch: Partial<OutreachOperationalStatus> = {}): Omit<OutreachOperationalStatus, 'reasonNoOutreach'> {
  const base: OutreachOperationalStatus = {
    workspaceId: 'ws-a', timezone: 'America/Nassau', enabled: true, paused: false,
    pause: { paused: false, source: 'unknown', reason: null, pausedAt: null, activeSafetyCondition: null, disposition: 'running' },
    schedule: { sourcing: '', autosend: '', nextRunAt: null },
    lastScan: { ranAt: '2026-08-13T10:00:00Z', succeeded: true, summary: {}, error: null },
    sendsToday: { sent: 0, dailyLimit: 50, remaining: 50, firstTouch: 0, followups: 0, firstTouchTarget: 50, firstTouchRemaining: 50 },
    sendsThisMonth: { firstTouch: 100, followups: 25, total: 125 },
    lastSourcing: { ranAt: '2026-08-13T09:00:00Z', succeeded: true, summary: {}, error: null },
    queue: { pendingDrafts: 0, stalled: 0, sourcingJobs: 0 }, sourcing: { availableCandidates: 1, cooldownCandidates: 0, lastFound: 20, lastQualified: 14, lastRejected: 6, lastDuplicates: 2 },
    provider: { connected: true, healthy: true, kind: 'email', lastError: null }, blockers: [], telemetryComplete: true, reasonNoOutreach: null,
  }
  const merged = { ...base, ...patch }
  const { reasonNoOutreach: _reason, ...without } = merged
  return without
}

describe('authoritative outreach explanation', () => {
  it('reports pause', () => expect(explainNoOutreach(state({ paused: true }))).toMatch(/paused/))
  it('reports an active bounce safety pause as the concrete blocker', () => expect(explainNoOutreach(state({ paused: true, pause: { paused: true, source: 'bounce_safety', reason: '5 bounces', pausedAt: null, activeSafetyCondition: 'bounce_threshold', disposition: 'safety_active' } }))).toMatch(/bounce threshold safety stop/))
  it('reports cap', () => expect(explainNoOutreach(state({ sendsToday: { sent: 0, dailyLimit: 50, remaining: 0, firstTouch: 50, followups: 0, firstTouchTarget: 50, firstTouchRemaining: 0 } }))).toMatch(/limit/))
  it('reports zero leads', () => expect(explainNoOutreach(state({ sourcing: { availableCandidates: 0, cooldownCandidates: 14, lastFound: 20, lastQualified: 14, lastRejected: 6, lastDuplicates: 2 } }))).toMatch(/no currently sendable/))
  it('reports recorded all-failed qualification reason', () => expect(explainNoOutreach(state({ lastScan: { ranAt: '', succeeded: true, summary: { primary_zero_send_reason: 'all_failed_qualification' }, error: null } }))).toMatch(/all failed qualification/))
  it('returns null after successful outreach', () => expect(explainNoOutreach(state({ sendsToday: { sent: 5, dailyLimit: 50, remaining: 45, firstTouch: 5, followups: 0, firstTouchTarget: 50, firstTouchRemaining: 45 } }))).toBeNull())
  it('reports provider/auth failure', () => expect(explainNoOutreach(state({ provider: { connected: true, healthy: false, kind: 'email', lastError: 'token refresh failed' } }))).toMatch(/token refresh failed/))
  it('reports cron failure', () => expect(explainNoOutreach(state({ lastScan: { ranAt: '', succeeded: false, summary: null, error: 'timeout' } }))).toMatch(/timeout/))
  it('reports stalled queue', () => expect(explainNoOutreach(state({ queue: { pendingDrafts: 2, stalled: 2, sourcingJobs: 0 } }))).toMatch(/stalled/))
  it('does not hallucinate when telemetry is incomplete', () => expect(explainNoOutreach(state({ telemetryComplete: false, lastScan: { ranAt: null, succeeded: null, summary: null, error: null } }))).toMatch(/does not establish/))
  it('keeps the workspace identifier in the read model contract', () => expect(state({ workspaceId: 'ws-b' }).workspaceId).toBe('ws-b'))
  it('uses the Nassau business-day boundary rather than UTC', () => expect(startOfBusinessDay(new Date('2026-08-13T22:00:00Z'), 'America/Nassau')).toBe('2026-08-13T04:00:00.000Z'))
  it('uses the business-local month boundary rather than UTC', () => expect(startOfBusinessMonth(new Date('2026-08-13T22:00:00Z'), 'America/Nassau')).toBe('2026-08-01T04:00:00.000Z'))
})
