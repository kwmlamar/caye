import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({}) }))

import { decideApplication } from './autonomy'
import type { AutonomyCandidateInput } from './autonomy'
import type { StandingAuthorization } from '../standing-authorization'

function policy(overrides: Partial<StandingAuthorization> = {}): StandingAuthorization {
  return {
    enabled: true,
    authorizedAt: '2026-08-31T00:00:00Z',
    authorizedBy: 'founder',
    evidence: { instruction: 'Start applying for jobs for me. Up to 150 a day.' },
    revokedAt: null,
    pausedAt: null,
    pausedReason: null,
    minFitScore: 70,
    maxApplicationsPerDay: 150,
    allowedJobFamilies: [],
    allowedProviders: ['greenhouse'],
    excludedEmployers: [],
    pauseOnSubmissionUncertain: true,
    useVerifiedFactsOnly: true,
    ...overrides,
  }
}

function candidate(overrides: Partial<AutonomyCandidateInput> = {}): AutonomyCandidateInput {
  return {
    applicationId: 'app-1',
    company: 'Acme',
    title: 'Software Engineer',
    fitScore: 82,
    provider: 'greenhouse',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    candidateStatus: 'QUALIFIED',
    unresolvedAnswerCount: 0,
    alreadySubmitted: false,
    challenge: null,
    ...overrides,
  }
}

describe('autonomous APPLY decision', () => {
  it('applies to a qualified in-policy job with no confirmation step', () => {
    expect(decideApplication(policy(), candidate())).toEqual({ decision: 'APPLY' })
  })

  it('applies when every consequential answer comes from verified facts', () => {
    expect(decideApplication(policy(), candidate({ unresolvedAnswerCount: 0 }))).toEqual({ decision: 'APPLY' })
  })

  it('does not treat consequentiality itself as a reason to interrupt the founder', () => {
    // A real submission to a real employer is exactly what was authorized.
    const decision = decideApplication(policy(), candidate({ fitScore: 100 }))
    expect(decision.decision).toBe('APPLY')
  })
})

describe('no standing authority means no autonomous submission', () => {
  it('escalates when no standing policy exists', () => {
    const decision = decideApplication(policy({ enabled: false }), candidate())
    expect(decision).toMatchObject({ decision: 'ESCALATE', category: 'no_standing_authorization' })
  })

  it('escalates when the policy is paused', () => {
    const decision = decideApplication(policy({ pausedAt: '2026-08-31T10:00:00Z', pausedReason: 'founder paused' }), candidate())
    expect(decision).toMatchObject({ decision: 'ESCALATE', category: 'no_standing_authorization' })
    expect((decision as { reason: string }).reason).toContain('paused')
  })

  it('escalates when the policy was revoked', () => {
    const decision = decideApplication(policy({ revokedAt: '2026-08-31T10:00:00Z' }), candidate())
    expect(decision).toMatchObject({ decision: 'ESCALATE', category: 'no_standing_authorization' })
  })

  it('escalates when the policy permits zero applications per day', () => {
    expect(decideApplication(policy({ maxApplicationsPerDay: 0 }), candidate()).decision).toBe('ESCALATE')
  })

  it('escalates when verified-facts-only has somehow been turned off', () => {
    expect(decideApplication(policy({ useVerifiedFactsOnly: false }), candidate()).decision).toBe('ESCALATE')
  })
})

describe('SKIP decisions record why', () => {
  it('skips a job below the fit threshold rather than lowering standards', () => {
    const decision = decideApplication(policy({ minFitScore: 70 }), candidate({ fitScore: 69 }))
    expect(decision).toMatchObject({ decision: 'SKIP', category: 'below_fit_threshold' })
    expect((decision as { reason: string }).reason).toContain('69')
  })

  it('skips a job with no fit score at all', () => {
    expect(decideApplication(policy(), candidate({ fitScore: null })).decision).toBe('SKIP')
  })

  it('skips a role outside the allowed job families', () => {
    const decision = decideApplication(
      policy({ allowedJobFamilies: ['software engineer'] }),
      candidate({ title: 'Regional Sales Director' }),
    )
    expect(decision).toMatchObject({ decision: 'SKIP', category: 'outside_job_family' })
  })

  it('allows a matching job family case-insensitively', () => {
    expect(decideApplication(
      policy({ allowedJobFamilies: ['Software Engineer'] }),
      candidate({ title: 'Senior software engineer, Platform' }),
    )).toEqual({ decision: 'APPLY' })
  })

  it('never resubmits an application that already submitted', () => {
    const decision = decideApplication(policy(), candidate({ alreadySubmitted: true }))
    expect(decision).toMatchObject({ decision: 'SKIP', category: 'already_applied' })
  })

  it('treats a possibly-submitted (uncertain) application as already applied', () => {
    // loadAutonomyCandidate counts submission_uncertain as prior submission.
    expect(decideApplication(policy(), candidate({ alreadySubmitted: true })).decision).toBe('SKIP')
  })

  it('skips an excluded employer', () => {
    const decision = decideApplication(policy({ excludedEmployers: ['Acme'] }), candidate({ company: 'acme' }))
    expect(decision).toMatchObject({ decision: 'SKIP', category: 'employer_excluded' })
  })

  it('skips an unsupported provider safely rather than attempting it', () => {
    const decision = decideApplication(policy(), candidate({ provider: 'generic', applyUrl: 'https://jobs.example.com/apply' }))
    expect(decision).toMatchObject({ decision: 'SKIP', category: 'provider_unsupported' })
  })

  it('skips a prohibited platform even when the provider looks allowed', () => {
    const decision = decideApplication(policy(), candidate({ applyUrl: 'https://www.linkedin.com/jobs/view/123' }))
    expect(decision.decision).toBe('SKIP')
    expect(['prohibited_destination', 'provider_unsupported']).toContain((decision as { category: string }).category)
  })

  it('skips a rejected candidate', () => {
    const decision = decideApplication(policy(), candidate({ candidateStatus: 'REJECTED' }))
    expect(decision).toMatchObject({ decision: 'SKIP', category: 'candidate_rejected' })
  })

  it('skips a duplicate before evaluating anything else, so it is never an interruption', () => {
    const decision = decideApplication(policy(), candidate({ alreadySubmitted: true, unresolvedAnswerCount: 3 }))
    expect(decision).toMatchObject({ decision: 'SKIP', category: 'already_applied' })
  })
})

describe('ESCALATE only for missing information or authority', () => {
  it('escalates an unresolved required question rather than inventing a founder fact', () => {
    const decision = decideApplication(policy(), candidate({ unresolvedAnswerCount: 1 }))
    expect(decision).toMatchObject({ decision: 'ESCALATE', category: 'unresolved_required_question' })
    expect((decision as { reason: string }).reason).toContain('inventing facts')
  })

  it('escalates a CAPTCHA rather than attempting to solve it', () => {
    const decision = decideApplication(policy(), candidate({ challenge: 'CAPTCHA challenge detected' }))
    expect(decision).toMatchObject({ decision: 'ESCALATE', category: 'challenge_encountered' })
  })

  it('escalates a login or identity-verification wall', () => {
    expect(decideApplication(policy(), candidate({ challenge: 'Account login required' })).decision).toBe('ESCALATE')
    expect(decideApplication(policy(), candidate({ challenge: 'Identity verification requested' })).decision).toBe('ESCALATE')
  })

  it('prefers a quiet SKIP over an interruption when the job simply does not qualify', () => {
    // Out of policy AND missing answers: the founder should not be asked about
    // a job Caye was never going to apply to.
    const decision = decideApplication(policy({ minFitScore: 90 }), candidate({ fitScore: 50, unresolvedAnswerCount: 2 }))
    expect(decision.decision).toBe('SKIP')
  })
})

describe('policy changes take effect on the next decision', () => {
  it('applies a raised threshold immediately, with no restart', () => {
    const job = candidate({ fitScore: 75 })
    expect(decideApplication(policy({ minFitScore: 70 }), job)).toEqual({ decision: 'APPLY' })
    expect(decideApplication(policy({ minFitScore: 80 }), job).decision).toBe('SKIP')
  })

  it('applies a newly added job-family restriction immediately', () => {
    const job = candidate({ title: 'Data Analyst' })
    expect(decideApplication(policy(), job)).toEqual({ decision: 'APPLY' })
    expect(decideApplication(policy({ allowedJobFamilies: ['software engineer'] }), job).decision).toBe('SKIP')
  })
})
