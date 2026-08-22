import { describe, expect, it } from 'vitest'
import { partialAccessibilityReplyFor } from './partial-accessibility-reply'

const FACTS = [
  {
    id: '1',
    category: 'service_detail' as const,
    fact: 'Bimini Island Tours can accommodate guests with walking limitations — tours can be run at a slower pace with reduced walking.',
  },
  {
    id: '2',
    category: 'service_detail' as const,
    fact: 'Wheelchair and mobility scooter accessibility is available on the North Bimini Heritage Tour only.',
  },
]

describe('partialAccessibilityReplyFor', () => {
  it('shares documented mobility facts but withholds unverified vehicle-safety details', () => {
    const reply = partialAccessibilityReplyFor(
      'My spouse uses a folded electric mobility scooter. Does the vehicle have a lift or ramp?',
      'Accessible tour inquiry',
      FACTS
    )

    expect(reply).toContain('North Bimini Heritage Tour')
    expect(reply).toContain('slower pace with reduced walking')
    expect(reply).toContain('confirming the vehicle fit and transfer requirements')
    expect(reply).not.toMatch(/has a lift|has a ramp|can safely transport/i)
  })

  it('does not manufacture an accessibility reply without both documented facts', () => {
    expect(
      partialAccessibilityReplyFor('Can you take a mobility scooter?', undefined, [FACTS[0]])
    ).toBeUndefined()
  })
})
