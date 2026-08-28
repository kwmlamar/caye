import { describe, expect, it } from 'vitest'
import { internalRedirectPath } from './internal-redirect'

describe('internalRedirectPath', () => {
  it('preserves a local OAuth consent continuation', () => {
    expect(internalRedirectPath('/oauth/consent?authorization_id=abc')).toBe('/oauth/consent?authorization_id=abc')
  })

  it.each(['https://attacker.example', '//attacker.example', '/\\attacker.example', 'oauth/consent', null])(
    'rejects external or malformed redirect %s',
    (value) => expect(internalRedirectPath(value)).toBeNull(),
  )
})
