import { describe, expect, it } from 'vitest'
import { excludePreviouslyObservedSources } from './runtime'

describe('independent research cross-check source filtering', () => {
  it('excludes every source URL already observed by the parent investigation', () => {
    const results = [
      { url: 'https://example.com/already-used' },
      { url: 'https://independent.example/new-evidence' },
      { url: 'https://example.com/already-used#fragment' },
    ]

    expect(excludePreviouslyObservedSources(results, ['https://example.com/already-used/']))
      .toEqual([{ url: 'https://independent.example/new-evidence' }])
  })
})
