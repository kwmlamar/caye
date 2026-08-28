import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { extractRichResult, validateRichResult } from '@/lib/caye-direct-rich-results'
import { propertyRichResultFromTurns } from './turn-rich-result'

describe('property snapshot rich results', () => {
  it('derives a trusted property card from a real structured snapshot tool call', () => {
    const propertyId = '123e4567-e89b-12d3-a456-426614174000'
    const turns: Anthropic.MessageParam[] = [{
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_property_snapshot', input: { property_id: propertyId } }],
    }]
    expect(propertyRichResultFromTurns(turns)?.blocks).toEqual([{ type: 'property_snapshot', propertyId }])
  })

  it('does not create a property card from prose or a different tool call', () => {
    const propertyId = '123e4567-e89b-12d3-a456-426614174000'
    const turns: Anthropic.MessageParam[] = [
      { role: 'assistant', content: `get_property_snapshot ${propertyId}` },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'get_customer', input: { customer_id: propertyId } }] },
    ]
    expect(propertyRichResultFromTurns(turns)).toBeUndefined()
  })

  it('rejects model-authored property snapshot blocks', () => {
    const propertyId = '123e4567-e89b-12d3-a456-426614174000'
    expect(validateRichResult({ version: 1, narrative: '', blocks: [{ type: 'property_snapshot', propertyId }] })).toBeNull()
  })

  it('strips a fenced attempt to author a property card instead of leaking raw JSON', () => {
    const propertyId = '123e4567-e89b-12d3-a456-426614174000'
    const text = `Property loaded.\n\n\`\`\`json\n${JSON.stringify({ version: 1, narrative: 'Property loaded.', blocks: [{ type: 'property_snapshot', propertyId }] })}\n\`\`\``
    const extracted = extractRichResult(text)
    expect(extracted.result).toBeUndefined()
    expect(extracted.narrative).toBe('Property loaded.')
  })
})
