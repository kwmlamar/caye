import { describe, expect, it } from 'vitest'
import {
  OPERATING_INTELLIGENCE_CAPABILITIES,
  hasDefensibleCapabilityProgress,
} from './operating-intelligence-capabilities'

describe('Operating Intelligence capability roadmap', () => {
  it('contains exactly the canonical twelve capabilities in roadmap order', () => {
    expect(OPERATING_INTELLIGENCE_CAPABILITIES.map((c) => c.title)).toEqual([
      'Perception & Continuous Awareness',
      'Memory & Context',
      'Research & Intelligence',
      'Reasoning & Simulation',
      'Planning & Anticipation',
      'Execution & Autonomy',
      'Monitoring & Control',
      'Engineering Copilot',
      'Environment & Machine Interface',
      'Adaptive Learning',
      'Proactive Operator',
      'Human Command Interface',
    ])
    expect(new Set(OPERATING_INTELLIGENCE_CAPABILITIES.map((c) => c.key)).size).toBe(12)
  })

  it('refuses to treat an unsupported numeric percentage as defensible progress', () => {
    expect(hasDefensibleCapabilityProgress({ progressPercent: 40, progressEvidenceId: null, lastVerifiedAt: null })).toBe(false)
    expect(hasDefensibleCapabilityProgress({ progressPercent: 40, progressEvidenceId: 7, lastVerifiedAt: null })).toBe(false)
    expect(hasDefensibleCapabilityProgress({ progressPercent: 40, progressEvidenceId: 7, lastVerifiedAt: '2026-08-30T00:00:00Z' })).toBe(true)
  })

  it('treats absent progress as valid rather than inventing a number', () => {
    expect(hasDefensibleCapabilityProgress({ progressPercent: null, progressEvidenceId: null, lastVerifiedAt: null })).toBe(true)
  })
})
