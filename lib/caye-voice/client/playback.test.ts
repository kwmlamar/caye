import { describe, it, expect } from 'vitest'
import { splitIntoSentences } from './playback'

describe('splitIntoSentences', () => {
  it('splits on sentence-ending punctuation', () => {
    expect(splitIntoSentences('Hi there. How are you? Great!')).toEqual(['Hi there.', 'How are you?', 'Great!'])
  })

  it('keeps a trailing fragment with no terminal punctuation as its own sentence', () => {
    expect(splitIntoSentences('One. Two')).toEqual(['One.', 'Two'])
  })

  it('returns an empty array for empty/whitespace-only text', () => {
    expect(splitIntoSentences('')).toEqual([])
    expect(splitIntoSentences('   ')).toEqual([])
  })

  it('treats a single sentence with no punctuation as one chunk', () => {
    expect(splitIntoSentences('She has asked twice for the invoice')).toEqual(['She has asked twice for the invoice'])
  })
})
