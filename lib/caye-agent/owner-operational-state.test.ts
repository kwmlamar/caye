import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import {
  needsAuthoritativeOwnerOperationalState,
  renderAuthoritativeOwnerOperationalState,
  type AuthoritativeOwnerOperationalState,
} from './owner-operational-state'

const state: AuthoritativeOwnerOperationalState = {
  capturedAt: '2026-08-19T15:00:00.000Z',
  outreach: {
    workspaceId: 'ws-a',
    timezone: 'America/Nassau',
    enabled: true,
    paused: false,
    schedule: { sourcing: '', autosend: '', nextRunAt: null },
    lastScan: { ranAt: '2026-08-19T14:00:00.000Z', succeeded: true, summary: {}, error: null },
    lastSourcing: { ranAt: '2026-08-19T13:00:00.000Z', succeeded: true, summary: {}, error: null },
    sendsToday: { sent: 0, dailyLimit: 50, remaining: 50 },
    sendsThisMonth: { firstTouch: 100, followups: 12, total: 112 },
    queue: { pendingDrafts: 86, stalled: 0, sourcingJobs: 0 },
    sourcing: { availableCandidates: 0, cooldownCandidates: 152, lastFound: 20, lastQualified: 9, lastRejected: 11, lastDuplicates: 0 },
    provider: { connected: true, healthy: true, kind: 'email', lastError: null },
    blockers: ['There are no currently sendable sourced leads.'],
    reasonNoOutreach: 'There are no currently sendable sourced leads.',
    telemetryComplete: true,
  },
}

describe('authoritative owner operational state', () => {
  it('preloads for broad owner-status questions', () => {
    expect(needsAuthoritativeOwnerOperationalState("what's going on with the business right now?")).toBe(true)
    expect(needsAuthoritativeOwnerOperationalState('What have you done today?')).toBe(true)
    expect(needsAuthoritativeOwnerOperationalState('What is the biggest bottleneck right now?')).toBe(true)
  })

  it('preloads for explicit outreach questions but not unrelated identity questions', () => {
    expect(needsAuthoritativeOwnerOperationalState('How is outreach doing?')).toBe(true)
    expect(needsAuthoritativeOwnerOperationalState('Who am I?')).toBe(false)
  })

  it('pins nonzero month sends and active pause state ahead of inference', () => {
    const rendered = renderAuthoritativeOwnerOperationalState(state)!
    expect(rendered).toContain('first_touch_sends_this_month: 100')
    expect(rendered).toContain('total_sends_this_month: 112')
    expect(rendered).toContain('outreach_paused: false')
    expect(rendered).toContain('outreach_running_now: true')
    expect(rendered).toContain('MUST NOT say or imply that zero emails have been sent this month')
  })

  it('does not let pending drafts become proof the entire funnel never sent', () => {
    const rendered = renderAuthoritativeOwnerOperationalState(state)!
    expect(rendered).toContain('pending_outreach_drafts: 86')
    expect(rendered).toContain('Pending drafts are a queue fact, not proof that the entire funnel is blocked')
  })

  it('forces uncertainty when telemetry is incomplete', () => {
    const rendered = renderAuthoritativeOwnerOperationalState({
      ...state,
      outreach: { ...state.outreach, telemetryComplete: false },
    })!
    expect(rendered).toContain('If telemetry_complete=false, do not invent a single root cause')
  })
})
