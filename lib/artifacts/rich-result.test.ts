import { describe, it, expect } from 'vitest'
import { businessArtifactRichResult, mergeRichResults } from './rich-result'
import { validateRichResult } from '@/lib/caye-direct-rich-results'

describe('businessArtifactRichResult — server-authored trusted blocks (multimodal Caye Direct follow-up)', () => {
  it('returns undefined for an empty id list', () => {
    expect(businessArtifactRichResult([])).toBeUndefined()
  })

  it('de-dupes repeated ids into one block each', () => {
    const result = businessArtifactRichResult(['a', 'a', 'b'])
    expect(result?.blocks).toEqual([
      { type: 'business_artifact', artifactId: 'a' },
      { type: 'business_artifact', artifactId: 'b' },
    ])
  })

  it('never carries a url — only an id crosses the boundary', () => {
    const result = businessArtifactRichResult(['artifact-1'])
    expect(JSON.stringify(result)).not.toMatch(/url/i)
  })

  it('a model-authored business_artifact block is rejected by validateRichResult — only server orchestration may introduce this block', () => {
    const forged = { version: 1, narrative: 'here', blocks: [{ type: 'business_artifact', artifactId: 'artifact-1' }] }
    expect(validateRichResult(forged)).toBeNull()
  })
})

describe('mergeRichResults', () => {
  it('returns the defined side when the other is undefined', () => {
    const a = businessArtifactRichResult(['a'])!
    expect(mergeRichResults(a, undefined)).toBe(a)
    expect(mergeRichResults(undefined, a)).toBe(a)
  })

  it('concatenates blocks from both sides — e.g. one turn returning both an engineering and a business artifact', () => {
    const business = businessArtifactRichResult(['biz-1'])!
    const engineering = { version: 1 as const, narrative: 'Engineering artifact ready.', blocks: [{ type: 'engineering_artifact' as const, artifactId: 'eng-1' }] }
    const merged = mergeRichResults(engineering, business)
    expect(merged?.blocks).toHaveLength(2)
    expect(merged?.blocks).toEqual(expect.arrayContaining([
      { type: 'engineering_artifact', artifactId: 'eng-1' },
      { type: 'business_artifact', artifactId: 'biz-1' },
    ]))
  })
})
