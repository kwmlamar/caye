import { describe, expect, it } from 'vitest'
import { detectWorkAuthSignals, evaluatePolicyGate, isProhibitedApplyDestination } from './policy-gate'

const baseSignals = {
  optExcluded: false,
  citizenshipRequired: false,
  clearanceRequired: false,
  ambiguousSponsorshipLanguage: false,
  evidence: [] as string[],
}

describe('detectWorkAuthSignals', () => {
  it('flags explicit no-OPT / no-sponsorship language', () => {
    const signals = detectWorkAuthSignals(
      'This role requires no OPT candidates. We are unable to sponsor work visas at this time.',
    )
    expect(signals.optExcluded).toBe(true)
  })

  it('flags explicit U.S. citizenship requirement', () => {
    const signals = detectWorkAuthSignals('Applicants must be a US citizen due to federal contract requirements.')
    expect(signals.citizenshipRequired).toBe(true)
  })

  it('flags explicit active clearance requirement', () => {
    const signals = detectWorkAuthSignals('Candidate must hold an active secret clearance prior to starting.')
    expect(signals.clearanceRequired).toBe(true)
  })

  it('flags ambiguous sponsorship language without resolving it', () => {
    const signals = detectWorkAuthSignals('We will discuss visa status and sponsorship during the interview process.')
    expect(signals.ambiguousSponsorshipLanguage).toBe(true)
    expect(signals.optExcluded).toBe(false)
    expect(signals.citizenshipRequired).toBe(false)
  })

  it('does not flag postings with no work-authorization language at all', () => {
    const signals = detectWorkAuthSignals('We are looking for a software engineer who loves shipping product.')
    expect(signals.optExcluded).toBe(false)
    expect(signals.citizenshipRequired).toBe(false)
    expect(signals.clearanceRequired).toBe(false)
    expect(signals.ambiguousSponsorshipLanguage).toBe(false)
  })
})

describe('evaluatePolicyGate — regression fixtures (#192)', () => {
  it('rejects explicit no-OPT/STEM language', () => {
    const result = evaluatePolicyGate({
      signals: { ...baseSignals, optExcluded: true, evidence: ['no OPT'] },
      minYearsExperienceRequired: 1,
      founderYearsExperience: 0,
      verifiedSponsorshipOverride: false,
    })
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.reason).toBe('opt_excluded')
  })

  it('rejects US-citizen-required roles when not satisfied', () => {
    const result = evaluatePolicyGate({
      signals: { ...baseSignals, citizenshipRequired: true, evidence: ['citizens only'] },
      minYearsExperienceRequired: 0,
      founderYearsExperience: 1,
      verifiedSponsorshipOverride: false,
    })
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.reason).toBe('citizenship_required')
  })

  it('rejects active-clearance-required roles when not satisfied', () => {
    const result = evaluatePolicyGate({
      signals: { ...baseSignals, clearanceRequired: true, evidence: ['active secret clearance'] },
      minYearsExperienceRequired: 0,
      founderYearsExperience: 1,
      verifiedSponsorshipOverride: false,
    })
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.reason).toBe('clearance_required')
  })

  it('routes ambiguous sponsorship language to human review, not auto-reject or auto-clear', () => {
    const result = evaluatePolicyGate({
      signals: { ...baseSignals, ambiguousSponsorshipLanguage: true, evidence: ['sponsorship'] },
      minYearsExperienceRequired: 0,
      founderYearsExperience: 1,
      verifiedSponsorshipOverride: false,
    })
    expect(result.outcome).toBe('needs_human')
  })

  it('a verified sponsorship override resolves ambiguous language to clear', () => {
    const result = evaluatePolicyGate({
      signals: { ...baseSignals, ambiguousSponsorshipLanguage: true, evidence: ['sponsorship'] },
      minYearsExperienceRequired: 0,
      founderYearsExperience: 1,
      verifiedSponsorshipOverride: true,
    })
    expect(result.outcome).toBe('clear')
  })

  it('rejects a senior role requiring 8+ years for this junior-target profile', () => {
    const result = evaluatePolicyGate({
      signals: baseSignals,
      minYearsExperienceRequired: 8,
      founderYearsExperience: 1,
      verifiedSponsorshipOverride: false,
    })
    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.reason).toBe('experience_gap_too_large')
  })

  it('does not block a role within the junior/early-career experience threshold', () => {
    const result = evaluatePolicyGate({
      signals: baseSignals,
      minYearsExperienceRequired: 2,
      founderYearsExperience: 1,
      verifiedSponsorshipOverride: false,
    })
    expect(result.outcome).toBe('clear')
  })
})

describe('isProhibitedApplyDestination', () => {
  it('blocks LinkedIn apply URLs', () => {
    expect(isProhibitedApplyDestination('https://www.linkedin.com/jobs/view/12345')).toBe(true)
  })

  it('blocks Indeed apply URLs', () => {
    expect(isProhibitedApplyDestination('https://apply.indeed.com/apply/abc123')).toBe(true)
  })

  it('allows a compliant employer ATS domain', () => {
    expect(isProhibitedApplyDestination('https://boards.greenhouse.io/exampleco/jobs/12345')).toBe(false)
  })

  it('treats an unparseable URL as prohibited rather than assuming safe', () => {
    expect(isProhibitedApplyDestination('not-a-url')).toBe(true)
  })
})
