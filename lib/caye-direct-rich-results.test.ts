import { describe, expect, it } from 'vitest'
import { extractRichResult, validateRichResult } from './caye-direct-rich-results'

describe('Caye Direct rich results', () => {
  it('keeps legacy plain text compatible', () => expect(extractRichResult('A normal answer.')).toEqual({ narrative: 'A normal answer.' }))

  it('accepts a small semantic table', () => expect(validateRichResult({ version: 1, narrative: 'Here.', blocks: [{ type: 'table', columns: ['Name'], rows: [['Ada']] }] })?.blocks[0].type).toBe('table'))

  it('ignores ordinary code fences and extracts one validated rich envelope', () => {
    const reply = [
      'Here is the code:',
      '```ts',
      'const x = 1',
      '```',
      '```json',
      JSON.stringify({ version: 1, narrative: 'Useful summary.', blocks: [{ type: 'metric', label: 'Count', value: '1' }] }),
      '```',
    ].join('\n')
    const extracted = extractRichResult(reply)
    expect(extracted.narrative).toBe('Useful summary.')
    expect(extracted.result?.blocks[0]).toEqual({ type: 'metric', label: 'Count', value: '1' })
  })

  it('fails closed for executable, unknown, or navigational model UI', () => {
    expect(validateRichResult({ version: 1, narrative: 'x', blocks: [{ type: 'component', name: 'DangerousWidget' }] })).toBeNull()
    expect(validateRichResult({ version: 1, narrative: 'x', blocks: [{ type: 'artifact_reference', id: 'x', name: 'x', url: 'https://example.com' }] })).toBeNull()
  })
})
