/**
 * Job-search operator (CAY-194 / #194) — adversarial classifier coverage.
 *
 * Every label below is real ATS question wording. The property under test is
 * not "does it classify" but "can it EVER classify to a key whose stored
 * answer would be wrong here". Refusing (null) is always an acceptable
 * outcome — it escalates to the founder. Silently mapping to the wrong key
 * is not, because the stored answer then becomes a false statement to an
 * employer.
 */
import { describe, expect, it } from 'vitest'
import { classifyFieldLabel } from './field-classifier'

describe('classifyFieldLabel — polarity/negation safety (the sharpest failure mode)', () => {
  // These two questions have OPPOSITE correct answers and both contain
  // "sponsor". Before this was fixed they classified identically and would
  // have reused one stored boolean for both.
  it('"will you require sponsorship" and "authorized to work without sponsorship" never share a key', () => {
    const requires = classifyFieldLabel('Will you now or in the future require sponsorship for an employment visa?')
    const without = classifyFieldLabel('Are you legally authorized to work in the United States without sponsorship?')
    expect(requires).toBe('sponsorship')
    // The negated form must refuse rather than reuse `requires`' answer.
    expect(without).toBeNull()
    expect(without).not.toBe(requires)
  })

  it.each([
    'Are you authorized to work without sponsorship?',
    'Do you NOT require sponsorship to work in this country?',
    'Are you unable to relocate for this role?',
    'Have you never been convicted of a felony?',
    'Do you not hold a valid driver’s license?',
    'Are you willing to travel, other than internationally?',
  ])('refuses the negated form rather than risking an inverted answer: %s', (label) => {
    expect(classifyFieldLabel(label)).toBeNull()
  })

  it('a plain (non-negated) sponsorship question still classifies normally', () => {
    expect(classifyFieldLabel('Do you require sponsorship now?')).toBe('sponsorship')
  })
})

describe('classifyFieldLabel — work authorization is not sponsorship', () => {
  it('an authorization question mentioning sponsorship is work_authorization, not sponsorship', () => {
    // Ordering regression: /sponsor/i used to win this, so an authorization
    // question would have been answered from a sponsorship fact.
    expect(classifyFieldLabel('Are you legally authorized to work in the United States?')).toBe('work_authorization')
    expect(classifyFieldLabel('Do you have the right to work in the UK?')).toBe('work_authorization')
    expect(classifyFieldLabel('Are you eligible to work in Canada?')).toBe('work_authorization')
  })
})

describe('classifyFieldLabel — canonical high-risk questions map to their own key', () => {
  it.each([
    ['Are you a U.S. citizen?', 'citizenship'],
    ['Do you currently hold an active security clearance?', 'clearance'],
    ['Have you ever been convicted of a felony?', 'criminal_history'],
    ['Are you willing to relocate?', 'relocation'],
    ['What are your compensation expectations?', 'compensation'],
    ['When can you start?', 'availability_start_date'],
    ['Do you have a valid driver’s license?', 'drivers_license'],
    ['Do you consent to a background check?', 'background_check_acknowledgment'],
    ['Do you agree to binding arbitration?', 'arbitration_acknowledgment'],
    ['I certify that the information provided is true and accurate', 'legal_attestation'],
  ])('%s -> %s', (label, expected) => {
    expect(classifyFieldLabel(label)).toBe(expected)
  })
})

describe('classifyFieldLabel — voluntary self-identification is recognized but never confused', () => {
  it.each([
    ['Disability Status', 'disability'],
    ['Veteran Status', 'veteran_status'],
    ['Race/Ethnicity', 'demographic'],
    ['Gender', 'demographic'],
    ['What are your pronouns?', 'demographic'],
  ])('%s -> %s', (label, expected) => {
    expect(classifyFieldLabel(label)).toBe(expected)
  })

  it('these are all high-risk keys, so the executor treats them as never-auto-fillable when optional', () => {
    // Guards the pairing between this classifier and executor.ts's optional
    // field policy: a demographic question that somehow arrived as REQUIRED
    // must still resolve through verified facts only, never a guess.
    expect(classifyFieldLabel('Voluntary Self-Identification of Disability')).toBe('disability')
  })
})

describe('classifyFieldLabel — never guesses on genuinely novel questions', () => {
  it.each([
    'Are you a U.S. person as defined under ITAR?',
    'Are you at least 18 years of age?',
    'What is your current country of residence?',
    'Have you previously worked at or consulted for GitLab?',
    'Are you subject to any post-employment restrictions with a past employer?',
    'What’s the name you’d prefer us to use throughout the interview process?',
    'Favorite programming language?',
  ])('refuses to classify: %s', (label) => {
    expect(classifyFieldLabel(label)).toBeNull()
  })
})

describe('classifyFieldLabel — structural fields', () => {
  it.each([
    ['First Name', 'first_name'],
    ['Last Name', 'last_name'],
    ['Email', 'email'],
    ['Phone', 'phone'],
    ['Resume/CV', 'resume'],
    ['Cover Letter', 'cover_letter'],
  ])('%s -> %s', (label, expected) => {
    expect(classifyFieldLabel(label)).toBe(expected)
  })

  it('a portfolio/profile URL is not mistaken for a structural contact field', () => {
    expect(classifyFieldLabel('LinkedIn Profile')).toBeNull()
    expect(classifyFieldLabel('GitHub URL')).toBeNull()
    expect(classifyFieldLabel('Portfolio Website')).toBeNull()
    expect(classifyFieldLabel('How did you hear about us?')).toBeNull()
  })
})
