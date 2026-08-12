import { describe, it, expect } from 'vitest'
import { stripTsComments } from './strip-ts-comments'

describe('stripTsComments', () => {
  it('blanks a line comment', () => {
    expect(stripTsComments("const a = 1 // sender_type: 'system'")).not.toContain('system')
  })

  it('blanks a block comment', () => {
    const src = "/* sender_type: 'system' was the bug */\nconst a = 1"
    const out = stripTsComments(src)
    expect(out).not.toContain('system')
    expect(out).toContain('const a = 1')
  })

  it('keeps real code intact', () => {
    const src = "insert({ sender_type: 'business' })"
    expect(stripTsComments(src)).toBe(src)
  })

  it('does not treat a URL as a comment', () => {
    // The case a regex gets wrong.
    const src = "const url = 'https://example.com'\nconst k = 'business'"
    expect(stripTsComments(src)).toBe(src)
  })

  it('does not open a comment from inside a string', () => {
    const src = "const s = '/* not a comment */'\nconst k = 'business'"
    expect(stripTsComments(src)).toBe(src)
  })

  it('handles template literals containing slashes', () => {
    const src = 'const t = `see https://x // y`\nconst k = 1'
    expect(stripTsComments(src)).toBe(src)
  })

  it('respects escaped quotes', () => {
    const src = "const s = 'it\\'s // fine'\nconst k = 1"
    expect(stripTsComments(src)).toBe(src)
  })

  it('preserves line numbers so guards report the right line', () => {
    // Guards slice on match index to compute a line number; collapsing
    // comments would report every offender on the wrong line.
    const src = "// a\n/* b\n   c */\nconst k = 'business'"
    const out = stripTsComments(src)
    expect(out.split('\n')).toHaveLength(src.split('\n').length)
    expect(out.split('\n')[3]).toBe("const k = 'business'")
  })

  it('preserves byte length exactly', () => {
    const src = "const a = 1 // hello\n/* block */ const b = 2"
    expect(stripTsComments(src)).toHaveLength(src.length)
  })

  it('survives an unterminated block comment', () => {
    expect(() => stripTsComments('/* never closed')).not.toThrow()
  })
})
