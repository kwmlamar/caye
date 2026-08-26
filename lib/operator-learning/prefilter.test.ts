import { describe, it, expect } from 'vitest'
import { prefilterOperatorMessage } from './prefilter'

describe('prefilterOperatorMessage', () => {
  it('skips a bare acknowledgement', () => {
    expect(prefilterOperatorMessage('Ok').worthClassifying).toBe(false)
    expect(prefilterOperatorMessage('Thanks!').worthClassifying).toBe(false)
    expect(prefilterOperatorMessage('👍').worthClassifying).toBe(false)
  })

  it('skips a question the operator is asking Caye ("Tell Autumn I\'ll call tomorrow" is NOT a question, must pass through)', () => {
    expect(prefilterOperatorMessage('Is there a refund request from Juli?').worthClassifying).toBe(false)
    expect(prefilterOperatorMessage("Tell Autumn I'll call her tomorrow.").worthClassifying).toBe(true)
  })

  it('skips text too short to plausibly contain reusable knowledge', () => {
    expect(prefilterOperatorMessage('hi').worthClassifying).toBe(false) // 2 chars
    expect(prefilterOperatorMessage('short').worthClassifying).toBe(false) // 5 chars, below MIN_LENGTH (8)
    expect(prefilterOperatorMessage('long enough').worthClassifying).toBe(true) // 11 chars, clears MIN_LENGTH
  })

  it('passes an ordinary teaching statement through', () => {
    const r = prefilterOperatorMessage('Bottled water is $2.50 per guest, one bottle per person.')
    expect(r.worthClassifying).toBe(true)
  })

  it('flags obvious one-off language ("give this guest $90")', () => {
    const r = prefilterOperatorMessage('Give this guest the shared tour for $90, just this time.')
    expect(r.hints.obviousOneOff).toBe(true)
  })

  it('flags obvious durable language ("we only", "always")', () => {
    expect(prefilterOperatorMessage('We only use online payment.').hints.obviousDurable).toBe(true)
    expect(prefilterOperatorMessage('Always confirm the pickup time first.').hints.obviousDurable).toBe(true)
  })

  it('flags a specific-date mention', () => {
    expect(prefilterOperatorMessage('Only private tours are available on September 5.').hints.mentionsSpecificDate).toBe(true)
    expect(prefilterOperatorMessage('We only have private available that day.').hints.mentionsSpecificDate).toBe(true)
  })
})
