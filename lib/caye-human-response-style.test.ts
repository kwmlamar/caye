import { describe, expect, it } from 'vitest'
import { CAYE_HUMAN_RESPONSE_STYLE } from './caye-human-response-style'

describe('CAYE_HUMAN_RESPONSE_STYLE', () => {
  it('requires plain, simple, concise human language', () => {
    expect(CAYE_HUMAN_RESPONSE_STYLE).toContain('plain, simple English')
    expect(CAYE_HUMAN_RESPONSE_STYLE).toContain('high school student')
    expect(CAYE_HUMAN_RESPONSE_STYLE).toContain('short sentences')
    expect(CAYE_HUMAN_RESPONSE_STYLE).toContain('Keep replies concise')
  })

  it('forbids every long-dash variant without containing one itself', () => {
    expect(CAYE_HUMAN_RESPONSE_STYLE).toContain('Never use an em dash')
    expect(CAYE_HUMAN_RESPONSE_STYLE).not.toMatch(/[—–―]/)
  })
})
