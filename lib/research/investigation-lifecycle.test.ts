import { describe, expect, it } from 'vitest'
import { decideInvestigationLifecycle, type InvestigationMode } from './investigation-lifecycle'

function question(mode: InvestigationMode, overrides: Record<string, unknown> = {}) {
  return {
    id: 'q-1',
    investigation_mode: mode,
    lifecycle_status: 'active' as const,
    next_review_at: null,
    refresh_interval_hours: mode === 'monitor' ? 24 : 6,
    autonomous_run_count: 0,
    max_autonomous_runs: mode === 'monitor' ? 48 : 8,
    no_change_streak: 0,
    ...overrides,
  }
}

const now = new Date('2026-09-01T00:00:00.000Z')

describe('autonomous research investigation lifecycle', () => {
  it('resolves a one-shot after its evidence-backed run even when unknowns remain', () => {
    const result = decideInvestigationLifecycle({
      question: question('one_shot'),
      brief: { unknowns: ['one unanswered detail'], conflicting_evidence: [], material_changes: [] },
      now,
    })
    expect(result.lifecycleStatus).toBe('resolved')
    expect(result.nextReviewAt).toBeNull()
    expect(result.reason).toBe('one_shot_complete_with_open_questions')
  })

  it('revisits a follow-until-resolved investigation while material unknowns remain', () => {
    const result = decideInvestigationLifecycle({
      question: question('follow_until_resolved'),
      brief: { unknowns: ['Who owns the remaining stake?'], conflicting_evidence: [], material_changes: [] },
      now,
    })
    expect(result.lifecycleStatus).toBe('active')
    expect(result.reason).toBe('material_unknowns_remain')
    expect(result.nextReviewAt).toBe('2026-09-01T06:00:00.000Z')
  })

  it('accelerates contradiction cross-checking', () => {
    const result = decideInvestigationLifecycle({
      question: question('follow_until_resolved'),
      brief: { unknowns: [], conflicting_evidence: [{ source: 'primary source disagrees' }], material_changes: [] },
      now,
    })
    expect(result.reason).toBe('contradictory_evidence_requires_recheck')
    expect(result.nextReviewAt).toBe('2026-09-01T03:00:00.000Z')
    expect(result.materialChanged).toBe(true)
  })

  it('resolves follow-until-resolved once conflicts and unknowns disappear', () => {
    const result = decideInvestigationLifecycle({
      question: question('follow_until_resolved', { autonomous_run_count: 2 }),
      brief: { unknowns: [], conflicting_evidence: [], material_changes: [] },
      now,
    })
    expect(result.lifecycleStatus).toBe('resolved')
    expect(result.reason).toBe('evidence_resolved')
  })

  it('backs monitoring off when repeated checks find no material change', () => {
    const result = decideInvestigationLifecycle({
      question: question('monitor', { no_change_streak: 2 }),
      brief: { unknowns: [], conflicting_evidence: [], material_changes: [] },
      now,
    })
    expect(result.lifecycleStatus).toBe('active')
    expect(result.reason).toBe('monitor_unchanged_backoff')
    expect(result.nextReviewAt).toBe('2026-09-08T00:00:00.000Z')
  })

  it('brings monitoring forward after a material change', () => {
    const result = decideInvestigationLifecycle({
      question: question('monitor', { no_change_streak: 4 }),
      brief: { unknowns: [], conflicting_evidence: [], material_changes: ['new transaction filing'] },
      now,
    })
    expect(result.noChangeStreak).toBe(0)
    expect(result.reason).toBe('monitor_material_change')
    expect(result.nextReviewAt).toBe('2026-09-01T12:00:00.000Z')
  })

  it('halts at the hard autonomy budget instead of researching forever', () => {
    const result = decideInvestigationLifecycle({
      question: question('follow_until_resolved', { autonomous_run_count: 7, max_autonomous_runs: 8 }),
      brief: { unknowns: ['still unresolved'], conflicting_evidence: [], material_changes: [] },
      now,
    })
    expect(result.lifecycleStatus).toBe('paused')
    expect(result.nextReviewAt).toBeNull()
    expect(result.reason).toBe('autonomy_budget_exhausted')
  })
})
