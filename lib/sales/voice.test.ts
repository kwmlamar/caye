import { describe, expect, it } from 'vitest'
import { assignFirstTouchVariant, buildFirstTouchSystem, renderFirstTouchStructure } from './voice'

describe('assignFirstTouchVariant', () => {
  it('is deterministic — the same lead id always lands in the same bucket', () => {
    const ids = ['lead-1', 'a1b2c3', 'e7f8-9012-lead', 'zzz']
    for (const id of ids) {
      expect(assignFirstTouchVariant(id)).toBe(assignFirstTouchVariant(id))
    }
  })

  it('produces both variants across a range of ids, not a constant bucket', () => {
    const seen = new Set(Array.from({ length: 50 }, (_, i) => assignFirstTouchVariant(`lead-${i}`)))
    expect(seen.has('direct_pitch')).toBe(true)
    expect(seen.has('pain_point_question')).toBe(true)
  })
})

describe('renderFirstTouchStructure', () => {
  it('keeps the HOOK, WHO AND WHAT, and PROOF beats identical across variants', () => {
    const direct = renderFirstTouchStructure('direct_pitch')
    const painPoint = renderFirstTouchStructure('pain_point_question')
    const sharedBeats = (s: string) => s.split('\n').filter((line) => /^[1-3]\./.test(line))
    expect(sharedBeats(direct)).toEqual(sharedBeats(painPoint))
  })

  it('varies only the CLOSE beat between variants', () => {
    const direct = renderFirstTouchStructure('direct_pitch')
    const painPoint = renderFirstTouchStructure('pain_point_question')
    expect(direct).not.toBe(painPoint)
    expect(direct).toContain('4. CLOSE. State plainly')
    expect(painPoint).toContain('4. CLOSE. One short question that surfaces the cost')
  })
})

describe('buildFirstTouchSystem', () => {
  const baseArgs = {
    workspaceVoice: 'Bahamian, warm, direct.',
    leadName: 'Ari',
    businessName: 'Example Tours',
    trackedLink: 'https://meetcaye.com/r/abc123',
    variant: 'direct_pitch' as const,
  }

  it('includes real scraped evidence and instructs the model to paraphrase, not quote, it', () => {
    const system = buildFirstTouchSystem({
      ...baseArgs,
      evidence: 'Family-run snorkeling and reef tours out of Freeport since 1998.',
    })
    expect(system).toContain('Family-run snorkeling and reef tours out of Freeport since 1998.')
    expect(system).toContain('never quote it verbatim')
  })

  it('tells the model to stay honest and not invent detail when no evidence was found', () => {
    const system = buildFirstTouchSystem({ ...baseArgs, evidence: null })
    expect(system).toContain('No specific detail about this business was found')
    expect(system).toContain('Never invent a specific detail about them you do not have.')
  })

  it('treats a missing evidence field the same as an explicit null', () => {
    const withUndefined = buildFirstTouchSystem({ ...baseArgs, leadName: 'Same', businessName: 'Same' })
    const withNull = buildFirstTouchSystem({ ...baseArgs, evidence: null, leadName: 'Same', businessName: 'Same' })
    expect(withUndefined).toBe(withNull)
  })
})
