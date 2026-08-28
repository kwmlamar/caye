import { describe, expect, it } from 'vitest'
import { extractRichResult, validateRichResult } from '@/lib/caye-direct-rich-results'

describe('property snapshot rich results', () => {
  it('accepts a semantic property snapshot pointer with no embedded data', () => {
    const propertyId = '123e4567-e89b-12d3-a456-426614174000'
    const result = validateRichResult({
      version: 1,
      narrative: 'Here is the property model.',
      blocks: [{ type: 'property_snapshot', propertyId }],
    })
    expect(result?.blocks).toEqual([{ type: 'property_snapshot', propertyId }])
  })

  it('rejects malformed ids and embedded executable/UI payloads', () => {
    expect(validateRichResult({ version: 1, narrative: '', blocks: [{ type: 'property_snapshot', propertyId: 'bad id with spaces' }] })).toBeNull()
    expect(validateRichResult({ version: 1, narrative: '', blocks: [{ type: 'property_snapshot', propertyId: '<script>alert(1)</script>' }] })).toBeNull()
  })

  it('extracts the property pointer from a fenced rich envelope', () => {
    const propertyId = '123e4567-e89b-12d3-a456-426614174000'
    const text = `Property loaded.\n\n\`\`\`json\n${JSON.stringify({ version: 1, narrative: 'Property loaded.', blocks: [{ type: 'property_snapshot', propertyId }] })}\n\`\`\``
    const extracted = extractRichResult(text)
    expect(extracted.result?.blocks).toEqual([{ type: 'property_snapshot', propertyId }])
    expect(extracted.narrative).toBe('Property loaded.')
  })
})
