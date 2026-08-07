import { describe, it, expect } from 'vitest'
import { classifyOutboundAuthorship } from './message-authorship'

describe('classifyOutboundAuthorship', () => {
  it('treats a send with no stored draft as human-authored', () => {
    expect(classifyOutboundAuthorship('Hey, we run at 9 and 2.', undefined)).toEqual({
      authored_by: 'human',
    })
  })

  it('treats an empty or whitespace draft as no draft', () => {
    expect(classifyOutboundAuthorship('anything', '   \n ')).toEqual({ authored_by: 'human' })
  })

  it('credits Caye when the sent text matches her draft', () => {
    const draft = 'Hey,\n\nTotal Snorkel Cancun runs in a competitive market.'
    expect(classifyOutboundAuthorship(draft, draft)).toEqual({
      authored_by: 'caye',
      generated_by: 'caye',
    })
  })

  // The real regression: batch-approved cold outreach is Caye's words
  // dispatched by a person. Before this, it persisted as sent_by='human'
  // with nothing recording that she wrote it.
  it('credits Caye even though a human clicked send', () => {
    const draft = 'Hey,\n\nSethDive sells cenote experiences guests obsess over.'
    const result = classifyOutboundAuthorship(draft, draft)
    expect(result.generated_by).toBe('caye')
  })

  it('ignores whitespace reflow rather than calling it an edit', () => {
    const draft = 'Hey,\n\nWe have space Sunday.'
    const sent = 'Hey,  We have space Sunday.  '
    expect(classifyOutboundAuthorship(sent, draft)).toEqual({
      authored_by: 'caye',
      generated_by: 'caye',
    })
  })

  it('marks a rewritten draft as human_edited and withholds generated_by', () => {
    const draft = 'We can take 6 guests on Sunday at $95 each.'
    const sent = 'We can take 6 guests Sunday — $110 each, includes lunch.'
    const result = classifyOutboundAuthorship(sent, draft)
    expect(result).toEqual({ authored_by: 'human_edited' })
    expect(result.generated_by).toBeUndefined()
  })

  it('treats a non-string draft as absent', () => {
    expect(classifyOutboundAuthorship('hi', { some: 'object' })).toEqual({ authored_by: 'human' })
    expect(classifyOutboundAuthorship('hi', 42)).toEqual({ authored_by: 'human' })
  })
})
