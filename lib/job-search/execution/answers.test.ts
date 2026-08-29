/**
 * Job-search operator (CAY-194 / #194) — canonical answer provenance.
 *
 * Behavioral coverage, not type-level assertions: every one of these asserts
 * that a specific unsafe provenance actually FAILS to auto-fill, because the
 * cost of a wrong auto-fill is a false statement to an employer.
 */
import { describe, expect, it } from 'vitest'
import { FACT_MAX_AGE_MS, resolveDiscoveredField } from './answers'
import type { ProfileFactRow } from '../types'
import type { DiscoveredField } from './types'

const NOW = Date.parse('2026-08-29T00:00:00.000Z')

function textField(overrides: Partial<DiscoveredField> = {}): DiscoveredField {
  return {
    providerFieldId: 'question_1',
    label: 'Will you require sponsorship?',
    semanticKey: 'sponsorship',
    inputType: 'text',
    required: true,
    allowedOptions: null,
    confidence: 0.9,
    ...overrides,
  }
}

function factRow(overrides: Partial<ProfileFactRow> = {}): ProfileFactRow {
  return {
    id: 'fact-1',
    profile_id: 'profile-1',
    canonical_key: 'sponsorship',
    category: 'work_authorization',
    question: 'Will you require sponsorship?',
    answer: 'No',
    source: 'founder-direct',
    last_verified_at: new Date(NOW - 1000).toISOString(),
    superseded_at: null,
    ...overrides,
  }
}

describe('resolveDiscoveredField — what is allowed to auto-fill', () => {
  it('a recent, verified, founder-direct fact with an exact canonical-key match resolves', () => {
    const r = resolveDiscoveredField(textField(), [factRow()], NOW)
    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') {
      expect(r.value).toBe('No')
      expect(r.source).toBe('profile_fact')
    }
  })
})

describe('resolveDiscoveredField — what must never auto-fill', () => {
  it('an unclassified field is never filled, however many facts exist', () => {
    const r = resolveDiscoveredField(textField({ semanticKey: null }), [factRow()], NOW)
    expect(r.status).toBe('unresolved')
  })

  it('an inferred fact never auto-fills a consequential field', () => {
    const r = resolveDiscoveredField(textField(), [factRow({ source: 'inferred' })], NOW)
    expect(r.status).toBe('unresolved')
  })

  it('a fact from a different category never fills, even with a matching canonical key', () => {
    const r = resolveDiscoveredField(textField(), [factRow({ category: 'compensation' })], NOW)
    expect(r.status).toBe('unresolved')
  })

  it('a near-miss canonical key never fills — no fuzzy matching', () => {
    const r = resolveDiscoveredField(textField(), [factRow({ canonical_key: 'work_authorization' })], NOW)
    expect(r.status).toBe('unresolved')
  })

  it('a fact older than the re-confirmation window stops auto-filling and says when it was last confirmed', () => {
    const stale = factRow({ last_verified_at: new Date(NOW - FACT_MAX_AGE_MS - 86_400_000).toISOString() })
    const r = resolveDiscoveredField(textField(), [stale], NOW)
    expect(r.status).toBe('unresolved')
    if (r.status === 'unresolved') expect(r.reason).toMatch(/last confirmed on \d{4}-\d{2}-\d{2}/)
  })

  it('a fact just inside the window still fills (the boundary is not accidentally inverted)', () => {
    const fresh = factRow({ last_verified_at: new Date(NOW - FACT_MAX_AGE_MS + 60_000).toISOString() })
    expect(resolveDiscoveredField(textField(), [fresh], NOW).status).toBe('resolved')
  })

  it('a fact with an unparseable verification date is refused rather than trusted', () => {
    const r = resolveDiscoveredField(textField(), [factRow({ last_verified_at: 'not-a-date' })], NOW)
    expect(r.status).toBe('unresolved')
  })
})

describe('resolveDiscoveredField — closed option lists', () => {
  // Verified against a live Greenhouse board: the wire value is the option's
  // own identifier, and the same label maps to different identifiers on
  // different questions. A label can never be sent as-is.
  const selectField = textField({
    inputType: 'select',
    allowedOptions: [
      { label: 'Yes', value: '239207524002' },
      { label: 'No', value: '239207523002' },
    ],
  })

  it('resolves to the provider option IDENTIFIER, never the label', () => {
    const r = resolveDiscoveredField(selectField, [factRow({ answer: 'No' })], NOW)
    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') expect(r.value).toBe('239207523002')
  })

  it('matches case-insensitively on the label', () => {
    const r = resolveDiscoveredField(selectField, [factRow({ answer: 'no' })], NOW)
    if (r.status === 'resolved') expect(r.value).toBe('239207523002')
    else throw new Error('expected resolved')
  })

  it('a free-text answer that is not an offered option is escalated, never approximated', () => {
    // The single most dangerous near-miss: a perfectly good stored answer
    // that this particular employer does not actually offer as a choice.
    const r = resolveDiscoveredField(selectField, [factRow({ answer: 'No, I have OPT/EAD.' })], NOW)
    expect(r.status).toBe('unresolved')
    if (r.status === 'unresolved') expect(r.reason).toMatch(/does not match exactly one of the options/)
  })

  it('an answer matching no option is escalated', () => {
    const r = resolveDiscoveredField(selectField, [factRow({ answer: 'Maybe' })], NOW)
    expect(r.status).toBe('unresolved')
  })

  it('an ambiguous answer matching more than one option is escalated', () => {
    const dupes = textField({
      inputType: 'select',
      allowedOptions: [
        { label: 'Yes', value: '1' },
        { label: 'yes', value: '2' },
      ],
    })
    const r = resolveDiscoveredField(dupes, [factRow({ answer: 'Yes' })], NOW)
    expect(r.status).toBe('unresolved')
  })
})
