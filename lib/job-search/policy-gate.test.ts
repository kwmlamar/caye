import { describe, expect, it } from 'vitest'
import { detectWorkAuthSignals, evaluatePolicyGate, isProhibitedApplyDestination } from './policy-gate'

const baseSignals = {
  optExcluded: false,
  citizenshipRequired: false,
  clearanceRequired: false,
  ambiguousEligibilityLanguage: false,
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
    expect(signals.ambiguousEligibilityLanguage).toBe(true)
    expect(signals.optExcluded).toBe(false)
    expect(signals.citizenshipRequired).toBe(false)
  })

  it('does not flag postings with no work-authorization language at all', () => {
    const signals = detectWorkAuthSignals('We are looking for a software engineer who loves shipping product.')
    expect(signals.optExcluded).toBe(false)
    expect(signals.citizenshipRequired).toBe(false)
    expect(signals.clearanceRequired).toBe(false)
    expect(signals.ambiguousEligibilityLanguage).toBe(false)
  })

  // Adversarial regression fixtures — CAY-192 audit (2026-08-28). Every
  // phrase below was checked against the pre-audit pattern lists and
  // several silently fell through to "no signal at all" (i.e. the gate
  // would have returned `clear` for text that plainly disqualifies an
  // OPT/EAD candidate). See PR #196 audit notes.
  describe('adversarial work-authorization phrasing', () => {
    it('blocks "no CPT/OPT" even though "no" is not adjacent to "opt"', () => {
      const signals = detectWorkAuthSignals('Requirements: no C2C, no CPT/OPT, no sponsorship.')
      expect(signals.optExcluded).toBe(true)
    })

    it('blocks "no OPT/CPT" (reversed order)', () => {
      const signals = detectWorkAuthSignals('We cannot accept no OPT/CPT candidates for this position.')
      expect(signals.optExcluded).toBe(true)
    })

    it('blocks "must be authorized to work ... without ... sponsorship"', () => {
      const signals = detectWorkAuthSignals(
        'Candidates must be authorized to work in the United States without the need for employer sponsorship now or in the future.',
      )
      expect(signals.optExcluded).toBe(true)
    })

    it('blocks bare "active clearance required" with no clearance-level word', () => {
      const signals = detectWorkAuthSignals('This position requires an active clearance required prior to start.')
      expect(signals.clearanceRequired).toBe(true)
    })

    it('blocks "clearance required" alone', () => {
      const signals = detectWorkAuthSignals('Clearance required. No exceptions.')
      expect(signals.clearanceRequired).toBe(true)
    })

    it('blocks bare "U.S. Person" without the "as defined by ITAR" suffix', () => {
      const signals = detectWorkAuthSignals('Due to export control regulations, applicants must be a U.S. Person.')
      expect(signals.citizenshipRequired).toBe(true)
    })

    it('blocks "citizen or permanent resident" without a "U.S." prefix', () => {
      const signals = detectWorkAuthSignals('Applicant must be a citizen or permanent resident to be considered.')
      expect(signals.citizenshipRequired).toBe(true)
    })

    it('routes "eligible for clearance" to ambiguous review, not a silent clear', () => {
      const signals = detectWorkAuthSignals('Candidates must be eligible for a security clearance.')
      expect(signals.clearanceRequired).toBe(false)
      expect(signals.ambiguousEligibilityLanguage).toBe(true)
    })

    it('routes "ability to obtain clearance" to ambiguous review, not a silent clear', () => {
      const signals = detectWorkAuthSignals('Must have the ability to obtain a government security clearance.')
      expect(signals.clearanceRequired).toBe(false)
      expect(signals.ambiguousEligibilityLanguage).toBe(true)
    })

    it('does not hard-block "clearance preferred" (a soft signal, not a requirement) but still flags it for review', () => {
      const signals = detectWorkAuthSignals('Security clearance preferred but not required.')
      expect(signals.clearanceRequired).toBe(false)
      expect(signals.citizenshipRequired).toBe(false)
      expect(signals.optExcluded).toBe(false)
      // Bare mention of "clearance" is intentionally still routed through
      // to human review rather than treated as a confident "clear" —
      // keyword matching can't distinguish "preferred" nuance reliably
      // enough to auto-clear it outright.
      expect(signals.ambiguousEligibilityLanguage).toBe(true)
    })

    it('does not flag ordinary "opt-in" / "opt out" benefits language as eligibility-ambiguous', () => {
      const signals = detectWorkAuthSignals(
        'Employees can opt-in to the 401k match and may opt out of marketing texts at any time.',
      )
      expect(signals.ambiguousEligibilityLanguage).toBe(false)
      expect(signals.optExcluded).toBe(false)
    })

    it('still flags a bare "OPT" mention outside the opt-in/opt-out idiom', () => {
      const signals = detectWorkAuthSignals('Please indicate whether you are currently on OPT status in your application.')
      expect(signals.ambiguousEligibilityLanguage).toBe(true)
    })

    it('never resolves a hard-block phrase down to only "ambiguous" — block takes priority', () => {
      const signals = detectWorkAuthSignals('No CPT/OPT. Must be a U.S. citizen. Active clearance required.')
      expect(signals.optExcluded).toBe(true)
      expect(signals.citizenshipRequired).toBe(true)
      expect(signals.clearanceRequired).toBe(true)
      expect(signals.ambiguousEligibilityLanguage).toBe(false)
    })
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
      signals: { ...baseSignals, ambiguousEligibilityLanguage: true, evidence: ['sponsorship'] },
      minYearsExperienceRequired: 0,
      founderYearsExperience: 1,
      verifiedSponsorshipOverride: false,
    })
    expect(result.outcome).toBe('needs_human')
  })

  it('a verified sponsorship override resolves ambiguous language to clear', () => {
    const result = evaluatePolicyGate({
      signals: { ...baseSignals, ambiguousEligibilityLanguage: true, evidence: ['sponsorship'] },
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

  it('still hard-blocks 8+ years when experienceRequirementIsHard is unspecified (conservative default, back-compat)', () => {
    const result = evaluatePolicyGate({
      signals: baseSignals,
      minYearsExperienceRequired: 8,
      founderYearsExperience: 1,
      verifiedSponsorshipOverride: false,
    })
    expect(result.outcome).toBe('blocked')
  })

  it('does NOT hard-block 8+ years when it was explicitly "preferred" rather than required (#196 audit)', () => {
    // "8+ years preferred" is soft language — it does not actually rule
    // out an early-career candidate the way "8+ years required" does. A
    // large gap should still lower fit through scoring.ts's
    // experienceGapPenalty, but it must not be an outright policy-gate
    // reject the way a real hard minimum is.
    const result = evaluatePolicyGate({
      signals: baseSignals,
      minYearsExperienceRequired: 8,
      founderYearsExperience: 1,
      verifiedSponsorshipOverride: false,
      experienceRequirementIsHard: false,
    })
    expect(result.outcome).toBe('clear')
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
