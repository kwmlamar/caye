import { describe, expect, it } from 'vitest'
import { extractRichResult, validateRichResult } from './caye-direct-rich-results'

describe('Caye Direct rich results', () => {
  it('keeps legacy plain text compatible', () => expect(extractRichResult('A normal answer.')).toEqual({ narrative: 'A normal answer.' }))
  it('accepts a small semantic table', () => expect(validateRichResult({ version: 1, narrative: 'Here.', blocks: [{ type: 'table', columns: ['Name'], rows: [['Ada']] }] })?.blocks[0].type).toBe('table'))
  it('fails closed for executable or unknown model UI', () => {
    expect(validateRichResult({ version: 1, narrative: 'x', blocks: [{ type: 'component', name: 'DangerousWidget' }] })).toBeNull()
    expect(validateRichResult({ version: 1, narrative: 'x', blocks: [{ type: 'artifact_reference', id: 'x', name: 'x', url: 'javascript:alert(1)' }] })).toBeNull()
  })
})
