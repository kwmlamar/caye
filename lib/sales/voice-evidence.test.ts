import { describe, expect, it } from 'vitest'
import { assignFirstTouchVariant, buildFirstTouchSystem } from './voice'

const base = { workspaceVoice: '', leadName: 'Ari', businessName: 'Example Tours', trackedLink: 'https://example.test/demo', variant: 'direct_pitch' as const }

describe('first-touch evidence grounding', () => {
  it('keeps website description as observed fact, not proof of pain', () => {
    const prompt = buildFirstTouchSystem({ ...base, evidence: 'Family-run reef tours since 1998.' })
    expect(prompt).toContain('OBSERVED FACT FROM PROSPECT WEBSITE')
    expect(prompt).toContain('NOT evidence of slow replies, missed bookings, overwhelm, lost money')
    expect(prompt).toContain('HYPOTHESIS / GENERAL PAIN')
  })

  it('fails closed to known identity/category when evidence is absent', () => {
    const prompt = buildFirstTouchSystem({ ...base, evidence: null })
    expect(prompt).toContain('Do not invent a business-specific operational fact')
  })

  it('assigns a stable experiment variant per lead', () => {
    expect(assignFirstTouchVariant('lead-123')).toBe(assignFirstTouchVariant('lead-123'))
    expect(new Set(Array.from({ length: 30 }, (_, i) => assignFirstTouchVariant(`lead-${i}`))).size).toBe(2)
  })
})
