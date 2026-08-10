import { describe, it, expect } from 'vitest'
import { displayContactName, looksLikeEmailAddress } from './contact-display'

describe('looksLikeEmailAddress', () => {
  it('recognises an address', () => {
    expect(looksLikeEmailAddress('tuzi@comcast.net')).toBe(true)
  })

  it('does not mistake a name for one', () => {
    expect(looksLikeEmailAddress('Delysia Weeks')).toBe(false)
  })

  it('is not fooled by a name containing an at-sign word', () => {
    expect(looksLikeEmailAddress('Max @ Bimini')).toBe(false)
  })
})

describe('displayContactName', () => {
  it('takes the first real name', () => {
    expect(displayContactName('Delysia Weeks', 'tuzi@comcast.net')).toBe('Delysia Weeks')
  })

  // The 2026-08-09 ping read "tuzi needs your call" about Delysia Weeks.
  it('skips an email address entirely rather than using it as a name', () => {
    expect(displayContactName('tuzi@comcast.net')).toBe('A guest')
  })

  it('falls through an email to a later real name', () => {
    expect(displayContactName('tuzi@comcast.net', 'Delysia Weeks')).toBe('Delysia Weeks')
  })

  it('skips blanks', () => {
    expect(displayContactName('', '   ', 'Juli King')).toBe('Juli King')
  })

  it('has a generic last resort', () => {
    expect(displayContactName(null, undefined, '')).toBe('A guest')
  })
})
