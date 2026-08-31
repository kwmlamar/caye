import { describe, expect, it } from 'vitest'
import { chooseAuthoritativeEvidence, summarizeEpistemicEvidence } from './presentation'

describe('epistemic presentation', () => {
  it('marks stale durable memory instead of presenting it as current', () => {
    const result = summarizeEpistemicEvidence([{
      label: 'opening time', value: '9:00 AM', kind: 'durable_memory', confidence: 0.9,
      expiresAt: '2026-08-29T00:00:00Z', sourceLabel: 'stored business memory',
    }], new Date('2026-08-30T00:00:00Z'))
    expect(result.known).toHaveLength(0)
    expect(result.stale[0]).toContain('stale since')
  })

  it('surfaces a live observation contradicting memory as a conflict', () => {
    const result = summarizeEpistemicEvidence([
      { label: 'outreach state', value: 'paused', kind: 'observed_live', confidence: 1, environment: 'production', contradictedBy: ['stored-enabled'] },
      { label: 'outreach state', value: 'enabled', kind: 'durable_memory', confidence: 0.8 },
    ])
    expect(result.known.some(v => v.includes('Observed live'))).toBe(true)
    expect(result.conflicts[0]).toContain('contradictory validated source')
  })

  it('keeps explicit human correction above derived learning', () => {
    const chosen = chooseAuthoritativeEvidence([
      { label: 'deposit', value: '50%', kind: 'validated_learning', confidence: 1 },
      { label: 'deposit', value: '25%', kind: 'explicit_human', confidence: 0.8 },
    ])
    expect(chosen?.value).toBe('25%')
  })

  it('allows validated live evidence to supersede derived learning', () => {
    const chosen = chooseAuthoritativeEvidence([
      { label: 'provider health', value: 'healthy', kind: 'validated_learning', confidence: 1 },
      { label: 'provider health', value: 'down', kind: 'observed_live', confidence: 0.95, environment: 'production', supersedes: ['prior-derived'] },
    ])
    expect(chosen?.value).toBe('down')
    expect(chosen?.supersedes).toEqual(['prior-derived'])
  })

  it('never presents simulated evidence as a live observation', () => {
    const result = summarizeEpistemicEvidence([{
      label: 'send effect', value: 'message delivered', kind: 'observed_live', confidence: 1, environment: 'simulated',
    }])
    expect(result.known).toHaveLength(0)
    expect(result.inferred[0]).toContain('Inferred')
    expect(result.inferred[0]).toContain('environment: simulated')
  })

  it('never presents branch evidence as production observation', () => {
    const result = summarizeEpistemicEvidence([{
      label: 'feature behavior', value: 'works', kind: 'observed_live', confidence: 1, environment: 'branch',
    }])
    expect(result.known).toHaveLength(0)
    expect(result.inferred[0]).toContain('environment: branch')
  })

  it('keeps predictions separate from facts', () => {
    const result = summarizeEpistemicEvidence([{
      label: 'deployment effect', value: 'will reduce retries', kind: 'prediction', confidence: 0.7,
    }])
    expect(result.predictions).toHaveLength(1)
    expect(result.known).toHaveLength(0)
  })
})
