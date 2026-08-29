/**
 * Job-search operator (CAY-194 / #194) — canonical answer resolution for
 * discovered ATS fields.
 *
 * Deliberately narrower than it could be: every semantic key this module
 * knows how to resolve is in HIGH_RISK_FIELD_SEMANTIC_KEYS (types.ts) —
 * the exact "never answer novel consequential questions automatically"
 * category list from the issue. Resolution requires an EXACT match on
 * canonical_key === semanticKey (never fuzzy text similarity — a different
 * employer phrasing the same underlying question differently must not
 * silently reuse an unrelated fact) plus category agreement plus
 * source !== 'inferred' (mirrors application-executor.ts's existing
 * high-risk rule: these categories are never answerable by inference, only
 * by a verified founder-direct or resume-derived-and-verified fact).
 *
 * Structural fields (name/email/phone/resume/cover letter) are NOT
 * resolved here — the executor fills those directly from the founder
 * profile/contact info and the generated artifacts, since they are not
 * "canonical Q&A answers" in the profile_facts sense at all.
 */
import type { ProfileFactCategory, ProfileFactRow } from '../types'
import type { DiscoveredField, FieldResolution } from './types'

const SEMANTIC_KEY_TO_CATEGORY: Record<string, ProfileFactCategory> = {
  sponsorship: 'work_authorization',
  work_authorization: 'work_authorization',
  citizenship: 'citizenship',
  clearance: 'clearance',
  criminal_history: 'criminal_history',
  disability: 'disability',
  veteran_status: 'veteran',
  demographic: 'demographic',
  relocation: 'relocation',
  compensation: 'compensation',
  legal_attestation: 'attestation',
  willingness_to_travel: 'general',
  drivers_license: 'general',
  availability_start_date: 'general',
  background_check_acknowledgment: 'attestation',
  arbitration_acknowledgment: 'attestation',
}

export function resolveDiscoveredField(field: DiscoveredField, facts: ProfileFactRow[]): FieldResolution {
  if (!field.semanticKey) {
    return { status: 'unresolved', field, reason: `Field label "${field.label}" did not match any known category — never guessed.` }
  }
  const category = SEMANTIC_KEY_TO_CATEGORY[field.semanticKey]
  if (!category) {
    return { status: 'unresolved', field, reason: `Semantic key "${field.semanticKey}" has no mapped canonical-fact category.` }
  }
  const match = facts.find((f) => f.canonical_key === field.semanticKey && f.category === category && f.source !== 'inferred')
  if (!match) {
    return { status: 'unresolved', field, reason: `No verified canonical answer exists for "${field.label}" (semantic key: ${field.semanticKey}).` }
  }
  return { status: 'resolved', field, value: match.answer, source: 'profile_fact', profileFactId: match.id, reusable: true }
}

/** Structural fields the executor fills directly rather than through canonical-fact resolution. */
export const STRUCTURAL_SEMANTIC_KEYS = ['first_name', 'last_name', 'email', 'phone', 'resume', 'cover_letter'] as const
