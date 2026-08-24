import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import {
  decideInitialStatus,
  explainLearnedKnowledge,
  formatLearnedOperatingKnowledge,
  hasExplicitDurableScope,
  obviousOneOffInstruction,
  plausiblyReusableCorrection,
  type CorrectionCandidate,
  type LearnedOperatingKnowledge,
} from './operator-learning'

const cruiseProcedure: LearnedOperatingKnowledge = {
  id: 'bimini-cruise-pickup', knowledge_type: 'procedure', status: 'active', scope: { audience: 'cruise_guest' },
  trigger: { when: 'a cruise guest needs pre-tour arrival or pickup guidance', conditions: ['first-time arrival from a cruise pier'] },
  behavior: {
    do: ['explain the journey from disembarkation to the verified meeting point', 'include the complimentary tram when current verified logistics support it', 'make the journey feel simple and reassuring'],
    avoid: ['inventing a meeting point, pickup time, driver, phone number, or current transport fact'],
    requires_authoritative_state: ['meeting point', 'pickup time', 'driver', 'contact', 'current transport logistics'],
  },
  rationale: 'First-time cruise guests need the whole journey made explicit and easy.',
}

function candidate(overrides: Partial<CorrectionCandidate> = {}): CorrectionCandidate {
  return { learnable: true, reusable: true, knowledgeType: 'procedure', scope: {},
    trigger: { when: 'a recurring situation', conditions: [] }, behavior: { do: ['help'], avoid: [], requires_authoritative_state: [] },
    rationale: 'because', canonicalKey: 'procedure:test', confidence: .9, riskLevel: 'low', explicitDurable: false,
    oneOff: false, ...overrides }
}

describe('operator learning promotion policy', () => {
  it('promotes explicit, unambiguous low-risk durable guidance', () => {
    expect(hasExplicitDurableScope('For cruise guests, always explain the journey.')).toBe(true)
    expect(decideInitialStatus(candidate({ explicitDurable: true }))).toEqual({ status: 'active', reason: 'explicit_unambiguous_low_risk_instruction' })
  })
  it('keeps a single draft correction as a candidate and fails consequential knowledge closed', () => {
    expect(decideInitialStatus(candidate()).status).toBe('candidate')
    expect(decideInitialStatus(candidate({ explicitDurable: true, riskLevel: 'consequential' })).status).toBe('candidate')
    expect(decideInitialStatus(candidate({ explicitDurable: true, knowledgeType: 'business_fact' })).status).toBe('candidate')
  })
  it('isolates person-specific one-offs', () => {
    expect(obviousOneOffInstruction('For Jeff only, use 9:30 instead of 9:00.')).toBe(true)
    expect(plausiblyReusableCorrection('For Jeff only, use 9:30 instead of 9:00.', 'Draft at 9:00')).toBe(false)
  })
})

describe('fresh-context learned procedure rendering', () => {
  it('generalizes across fresh chat, abstraction and compression while pinning factual grounding', () => {
    const block = formatLearnedOperatingKnowledge([cruiseProcedure])
    expect(block).toContain('cruise guest needs pre-tour arrival or pickup guidance')
    expect(block).toContain('First-time cruise guests need the whole journey made explicit and easy')
    expect(block).toContain('complimentary tram')
    expect(block).toContain('not evidence for booking-specific or current objective facts')
    expect(block).toContain('never grant permission to send, book, charge, refund, promise')
    expect(block).not.toContain('Jeff')
    expect(block).not.toContain('Mrs. Max')
    expect(block).not.toContain('Casino is always the final stop')
  })
  it('retrieves only active rows in normal prompt rendering', () => {
    expect(formatLearnedOperatingKnowledge([{ ...cruiseProcedure, status: 'superseded' }])).toBe('')
  })
  it('explains provenance, status and supersession without database jargon', () => {
    const text = explainLearnedKnowledge({ ...cruiseProcedure, status: 'superseded', source_excerpt: 'Make the journey easy.', superseded_by: 'new-guidance' })
    expect(text).toContain('Status: superseded')
    expect(text).toContain('operator correction')
    expect(text).toContain('replaced by newer guidance')
  })
})
