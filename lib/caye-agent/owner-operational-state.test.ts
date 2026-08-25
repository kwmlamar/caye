import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import {
  needsAuthoritativeOwnerOperationalState,
  renderAuthoritativeOwnerOperationalState,
  type AuthoritativeOwnerOperationalState,
} from './owner-operational-state'

const state: AuthoritativeOwnerOperationalState = {
  capturedAt: '2026-08-20T04:08:00.000Z',
  workspace: {
    id: 'bimini-ws',
    name: 'Bimini Island Tours',
    timezone: 'America/Nassau',
    localDate: '2026-08-20',
    localTime: '00:08:00',
  },
  outreach: {
    workspaceId: 'ws-a',
    timezone: 'America/Nassau',
    enabled: true,
    paused: false,
    pause: { paused: false, source: 'unknown', reason: null, pausedAt: null, activeSafetyCondition: null, disposition: 'running' },
    schedule: { sourcing: '', autosend: '', nextRunAt: null },
    lastScan: { ranAt: '2026-08-19T14:00:00.000Z', succeeded: true, summary: {}, error: null },
    lastSourcing: { ranAt: '2026-08-19T13:00:00.000Z', succeeded: true, summary: {}, error: null },
    sendsToday: { sent: 0, dailyLimit: 50, remaining: 50, firstTouch: 0, followups: 0, firstTouchTarget: 50, firstTouchRemaining: 50 },
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
  it('preloads outreach for broad owner-status questions', () => {
    expect(needsAuthoritativeOwnerOperationalState("what's going on with the business right now?")).toBe(true)
    expect(needsAuthoritativeOwnerOperationalState('What have you done today?')).toBe(true)
    expect(needsAuthoritativeOwnerOperationalState('What is the biggest bottleneck right now?')).toBe(true)
  })

  it('loads outreach for explicit outreach questions but not unrelated identity questions', () => {
    expect(needsAuthoritativeOwnerOperationalState('How is outreach doing?')).toBe(true)
    expect(needsAuthoritativeOwnerOperationalState('Who am I?')).toBe(false)
  })

  it('pins routed workspace identity ahead of stale cross-workspace history', () => {
    const rendered = renderAuthoritativeOwnerOperationalState(state)!
    expect(rendered).toContain('CURRENT WORKSPACE — AUTHORITATIVE ROUTING STATE')
    expect(rendered).toContain('workspace_id: bimini-ws')
    expect(rendered).toContain('workspace_name: Bimini Island Tours')
    expect(rendered).toContain('Conversation history, prior workspace context, summaries, and model memory cannot override it')
    expect(rendered).toContain('Never claim the user switched to another workspace merely because an older message/history mentions one')
  })

  it('pins business-local clock and forbids today => happening-now inference', () => {
    const rendered = renderAuthoritativeOwnerOperationalState(state)!
    expect(rendered).toContain('business_local_date: 2026-08-20')
    expect(rendered).toContain('business_local_time: 00:08:00')
    expect(rendered).toContain('relative_to_today=today NEVER proves it is "happening now"')
    expect(rendered).toContain('scheduled today and give its scheduled time')
  })

  it('does not let a business outbound with unknown attribution become a Caye send claim', () => {
    const rendered = renderAuthoritativeOwnerOperationalState(state)!
    expect(rendered).toContain('sender_type=business proves only that the BUSINESS sent it')
    expect(rendered).toContain('It does NOT prove that Caye sent it')
    expect(rendered).toContain('Missing/null/unknown sender attribution must remain unknown')
  })

  it('renders base routing/time/provenance constraints even without outreach state', () => {
    const rendered = renderAuthoritativeOwnerOperationalState({ ...state, outreach: null })!
    expect(rendered).toContain('workspace_name: Bimini Island Tours')
    expect(rendered).toContain('PROVENANCE + TIME CLAIM CONSTRAINTS — DETERMINISTIC')
    expect(rendered).not.toContain('OUTREACH — AUTHORITATIVE FACTS')
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
      outreach: state.outreach ? { ...state.outreach, telemetryComplete: false } : null,
    })!
    expect(rendered).toContain('If telemetry_complete=false, do not invent a single root cause')
  })
})
