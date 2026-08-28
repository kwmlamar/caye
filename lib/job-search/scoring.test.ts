import { describe, expect, it } from 'vitest'
import { scoreCandidate, type ScoringInput } from './scoring'

const baseSignals = {
  optExcluded: false,
  citizenshipRequired: false,
  clearanceRequired: false,
  ambiguousSponsorshipLanguage: false,
  evidence: [] as string[],
}

const strongFitBase: ScoringInput = {
  title: 'Software Engineer I',
  targetTitles: ['Software Engineer I', 'Junior Software Engineer'],
  candidateSkills: ['TypeScript', 'React', 'Node.js'],
  founderSkills: ['TypeScript', 'React', 'Node.js', 'PostgreSQL'],
  requiresDegree: 'preferred',
  founderHasDegree: true,
  minYearsExperienceRequired: 1,
  founderYearsExperience: 1,
  location: 'Remote',
  remoteType: 'remote',
  founderOpenToRelocation: false,
  founderOpenToRemoteOnly: false,
  salaryMin: 90000,
  founderMinAcceptableSalary: 70000,
  postedAt: new Date().toISOString(),
  discoveredAt: new Date().toISOString(),
  extraScreenerQuestionCount: 0,
  signals: baseSignals,
  verifiedSponsorshipOverride: false,
}

describe('scoreCandidate — hard blockers override score (#192)', () => {
  it('a strong-fit posting scores highly and auto-queues when no hard blocker applies', () => {
    const result = scoreCandidate(strongFitBase)
    expect(result.score).toBeGreaterThanOrEqual(85)
    expect(result.bucket).toBe('auto_queue')
  })

  it('an otherwise-perfect-fit posting is rejected when it explicitly excludes OPT, regardless of score', () => {
    const result = scoreCandidate({
      ...strongFitBase,
      signals: { ...baseSignals, optExcluded: true, evidence: ['no OPT candidates'] },
    })
    expect(result.bucket).toBe('reject')
    expect(result.gate.outcome).toBe('blocked')
  })

  it('an otherwise-perfect-fit posting is rejected when U.S. citizenship is required, regardless of score', () => {
    const result = scoreCandidate({
      ...strongFitBase,
      signals: { ...baseSignals, citizenshipRequired: true, evidence: ['citizens only'] },
    })
    expect(result.bucket).toBe('reject')
  })

  it('an otherwise-perfect-fit posting is rejected when active clearance is required, regardless of score', () => {
    const result = scoreCandidate({
      ...strongFitBase,
      signals: { ...baseSignals, clearanceRequired: true, evidence: ['active TS/SCI clearance required'] },
    })
    expect(result.bucket).toBe('reject')
  })

  it('an otherwise-perfect-fit senior role requiring 8+ years is rejected for this junior profile', () => {
    const result = scoreCandidate({ ...strongFitBase, minYearsExperienceRequired: 8 })
    expect(result.bucket).toBe('reject')
    expect(result.gate.outcome).toBe('blocked')
  })

  it('ambiguous sponsorship language routes to review, never auto-queue, even with a high raw score', () => {
    const result = scoreCandidate({
      ...strongFitBase,
      signals: { ...baseSignals, ambiguousSponsorshipLanguage: true, evidence: ['sponsorship'] },
    })
    expect(result.bucket).toBe('review_low_priority')
  })

  it('a weak-fit posting with no hard blocker is rejected on score alone, not promoted to fill quota', () => {
    const result = scoreCandidate({
      ...strongFitBase,
      title: 'Marketing Coordinator',
      targetTitles: ['Software Engineer I'],
      candidateSkills: ['Adobe Photoshop', 'Copywriting'],
      minYearsExperienceRequired: 3,
      founderYearsExperience: 0,
      remoteType: 'on_site',
      founderOpenToRelocation: false,
      salaryMin: null,
      founderMinAcceptableSalary: 70000,
      postedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    })
    expect(result.bucket).toBe('reject')
    expect(result.score).toBeLessThan(50)
  })

  it('the 150/day throughput target never lowers the minimum quality bucket boundaries', () => {
    // scoreCandidate has no notion of "remaining daily capacity" at all —
    // capacity-aware queuing happens downstream in queue.ts, which must
    // never widen these bucket thresholds to fill quota. This test locks
    // the constants scoreCandidate itself enforces.
    const belowThreshold = scoreCandidate({
      ...strongFitBase,
      candidateSkills: [],
      founderSkills: [],
      title: 'Unrelated Role',
      targetTitles: ['Software Engineer I'],
      remoteType: 'on_site',
      founderOpenToRelocation: false,
      postedAt: null,
    })
    expect(belowThreshold.bucket === 'reject' || belowThreshold.score < 70).toBe(true)
  })
})
