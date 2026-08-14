import { describe, expect, it } from 'vitest'
import { liveOperatorDisplayNames } from './operator-display-name'

describe('liveOperatorDisplayNames', () => {
  it('uses a first name for an unambiguous Live conversation', () => {
    expect(liveOperatorDisplayNames([{ id: 1, name: 'Racquel Carey Bowe' }]).get(1)).toBe('Racquel')
  })

  it('uses full names when first names would be ambiguous', () => {
    const labels = liveOperatorDisplayNames([
      { id: 1, name: 'Racquel Carey Bowe' },
      { id: 2, name: 'Racquel Johnson' },
    ])
    expect(labels.get(1)).toBe('Racquel Carey Bowe')
    expect(labels.get(2)).toBe('Racquel Johnson')
  })

  it('keeps the unknown-name fallback', () => {
    expect(liveOperatorDisplayNames([{ id: 1, name: null }]).get(1)).toBe('Operator')
  })
})
