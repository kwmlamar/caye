import { describe, expect, it } from 'vitest'
import {
  canAdvanceResearchInvestigation,
  decideInvestigationLifecycle,
  investigationFollowUpCanonicalKey,
  planInvestigationFollowUps,
  type InvestigationMode,
} from './investigation-lifecycle'

function question(mode: InvestigationMode, overrides: Record<string, unknown> = {}) {
  return {
    id: 'q-1',
    investigation_mode: mode,
    lifecycle_status: 'active' as const,
    status: 'open',
    next_review_at: null,
    refresh_interval_hours: mode === 'monitor' ? 24 : 6,
    autonomous_run_count: 0,
    max_autonomous_runs: mode === 'monitor' ? 48 : 8,
    max_autonomous_followups: mode === 'follow_until_resolved' ? 6 : 0,
    no_change_streak: 0,
    ...overrides,
  }
}

const now = new Date('2026-09-01T00:00:00.000Z')

describe('autonomous research investigation lifecycle', () => {
  it('one-shot question pauses instead of pretending unresolved work is resolved', () => {
    const result = decideInvestigationLifecycle({
      question: question('one_shot'),
      brief: { unknowns: ['one unanswered detail'], conflicting_evidence: [], material_changes: [] },
      now,
    })
    expect(result.lifecycleStatus).toBe('paused')
    expect(result.nextReviewAt).toBeNull()
    expect(result.reason).toBe('one_shot_incomplete_with_open_questions')
  })

  it('one-shot question resolves only when no material unknowns or conflicts remain', () => {
    const result = decideInvestigationLifecycle({
      question: question('one_shot'),
      brief: { unknowns: [], conflicting_evidence: [], material_changes: [] },
      now,
    })
    expect(result.lifecycleStatus).toBe('resolved')
    expect(result.reason).toBe('one_shot_complete')
  })

  it('unknown generates a bounded follow-up question', () => {
    const children = planInvestigationFollowUps({ unknowns: ['Who owns the remaining stake?'], conflicting_evidence: [], material_changes: [] })
    expect(children).toHaveLength(1)
    expect(children[0].kind).toBe('autonomous_followup')
    expect(children[0].question).toContain('Who owns the remaining stake?')
  })

  it('contradiction triggers an independent cross-check', () => {
    const children = planInvestigationFollowUps({ unknowns: [], conflicting_evidence: [{ source: 'primary source disagrees' }], material_changes: [] })
    expect(children).toHaveLength(1)
    expect(children[0].kind).toBe('autonomous_cross_check')
    expect(children[0].question).toContain('not already relied on by the parent investigation')

    const decision = decideInvestigationLifecycle({
      question: question('follow_until_resolved'),
      brief: { unknowns: [], conflicting_evidence: ['primary source disagrees'], material_changes: [] },
      now,
    })
    expect(decision.reason).toBe('contradictory_evidence_requires_recheck')
    expect(decision.nextReviewAt).toBe('2026-09-01T03:00:00.000Z')
  })

  it('follow-until-resolved stays active while requested evidence is missing', () => {
    const result = decideInvestigationLifecycle({
      question: question('follow_until_resolved'),
      brief: { unknowns: ['Competitor 8 cancellation policy is still missing'], conflicting_evidence: [], material_changes: [] },
      now,
    })
    expect(result.lifecycleStatus).toBe('active')
    expect(result.reason).toBe('material_unknowns_remain')
    expect(result.nextReviewAt).toBe('2026-09-01T06:00:00.000Z')
  })

  it('monitoring question gets a future wakeup', () => {
    const result = decideInvestigationLifecycle({ question: question('monitor'), brief: { unknowns: [], conflicting_evidence: [], material_changes: ['new filing'] }, now })
    expect(result.lifecycleStatus).toBe('active')
    expect(result.nextReviewAt).toBe('2026-09-01T12:00:00.000Z')
  })

  it('unchanged result backs off', () => {
    const result = decideInvestigationLifecycle({ question: question('monitor', { no_change_streak: 2 }), brief: { unknowns: [], conflicting_evidence: [], material_changes: [] }, now })
    expect(result.reason).toBe('monitor_unchanged_backoff')
    expect(result.nextReviewAt).toBe('2026-09-08T00:00:00.000Z')
  })

  it('duplicate follow-up is suppressed with stable root-scoped identity', () => {
    const children = planInvestigationFollowUps({ unknowns: ['Who owns the remaining stake?', ' Who owns the remaining stake? '], conflicting_evidence: [], material_changes: [] })
    expect(children).toHaveLength(1)
    expect(investigationFollowUpCanonicalKey('root-1', children[0])).toBe(investigationFollowUpCanonicalKey('root-1', children[0]))
  })

  it('hard budget exhaustion stops safely', () => {
    const result = decideInvestigationLifecycle({
      question: question('follow_until_resolved', { autonomous_run_count: 7, max_autonomous_runs: 8 }),
      brief: { unknowns: ['still unresolved'], conflicting_evidence: [], material_changes: [] },
      now,
    })
    expect(result.lifecycleStatus).toBe('paused')
    expect(result.nextReviewAt).toBeNull()
    expect(result.reason).toBe('autonomy_budget_exhausted')
  })

  it('archived and resolved questions do not restart accidentally', () => {
    expect(canAdvanceResearchInvestigation(question('monitor', { status: 'archived' }))).toBe(false)
    expect(canAdvanceResearchInvestigation(question('monitor', { lifecycle_status: 'resolved' }))).toBe(false)
    expect(canAdvanceResearchInvestigation(question('monitor', { lifecycle_status: 'active', status: 'open' }))).toBe(true)
  })
})
