import { describe, it, expect } from 'vitest'
import { checkZohoDraftGate } from './zoho-draft-gate'

describe('checkZohoDraftGate', () => {
  it('opens on the string true, as platform_settings stores it', () => {
    expect(checkZohoDraftGate('true').allowed).toBe(true)
  })

  it('opens on a real boolean too', () => {
    expect(checkZohoDraftGate(true).allowed).toBe(true)
  })

  // Every one of these means "nobody has proven Zoho honours mode:draft",
  // and an unhonoured mode:draft mails a half-written reply to a guest.
  it.each([
    ['missing row', undefined],
    ['null value', null],
    ['explicit false', 'false'],
    ['boolean false', false],
    ['empty string', ''],
    ['unexpected garbage', 'yes'],
    ['a number', 1],
  ])('fails closed on %s', (_label, value) => {
    expect(checkZohoDraftGate(value).allowed).toBe(false)
  })

  it('explains the block in the operator\'s terms, not internal jargon', () => {
    const result = checkZohoDraftGate(null)
    expect(result.reason).toBeDefined()
    expect(result.reason).not.toMatch(/platform_settings|mode:draft|gate/i)
    // Always offers the fallback that still works today.
    expect(result.reason).toMatch(/paste/i)
  })
})
