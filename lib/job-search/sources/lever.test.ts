import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { leverAdapter } from './lever'

/**
 * Regression fixtures for the CAY-192 audit (PR #196). Verified live
 * against api.lever.co/v0/postings/{site} (2026-08-28): descriptionPlain
 * is ONLY the intro blurb — the actual "Requirements" section (and every
 * other named section: "What You'll Do", "Nice to Have", "Compensation",
 * etc) lives in a separate `lists` array that the original adapter never
 * read at all, so detectWorkAuthSignals never saw a Lever posting's real
 * requirements text. Fixture shape below mirrors a real captured response.
 */
function fakeFetchResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response
}

const REAL_SHAPE_POSTING = {
  id: 'posting-1',
  text: 'Engineering Manager',
  hostedUrl: 'https://jobs.lever.co/veeva/posting-1',
  applyUrl: 'https://jobs.lever.co/veeva/posting-1/apply',
  createdAt: 1735689600000,
  descriptionPlain: 'Veeva Systems is a mission-driven organization...',
  categories: { location: 'Remote - USA', team: 'Engineering', commitment: 'Full-time' },
  workplaceType: 'remote',
  lists: [
    { text: "What You'll Do", content: '<div>\n<li>Lead a team</li>\n</div>' },
    { text: 'Requirements', content: '<div>\n<li>Must be a U.S. citizen</li>\n<li>1+ years work experience</li>\n</div>' },
    { text: 'Nice to Have', content: '<div>\n<li>Connection with Life Sciences</li>\n</div>' },
  ],
  salaryRange: { min: 90000, max: 120000, currency: 'USD' },
}

describe('leverAdapter — reads the actual requirements section (#196 audit)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('includes the "Requirements" lists[] section content in requirements, not just descriptionPlain', async () => {
    fetchSpy.mockResolvedValue(fakeFetchResponse([REAL_SHAPE_POSTING]))

    const { postings } = await leverAdapter.fetchCandidates({ sites: ['veeva'] })

    expect(postings).toHaveLength(1)
    // This is the exact bug this audit found: the pre-fix adapter's
    // `requirements` field only ever contained descriptionPlain, which
    // NEVER includes "Must be a U.S. citizen" — that language lives only
    // in the "Requirements" lists[] section.
    expect(postings[0].requirements).toMatch(/Must be a U\.S\. citizen/)
    expect(postings[0].requirements).toMatch(/1\+ years work experience/)
    // HTML from the lists[] content must be stripped, not passed through raw.
    expect(postings[0].requirements).not.toMatch(/<li>|<div>/)
  })

  it('reads the real salaryRange field instead of hardcoding salary to null', async () => {
    fetchSpy.mockResolvedValue(fakeFetchResponse([REAL_SHAPE_POSTING]))

    const { postings } = await leverAdapter.fetchCandidates({ sites: ['veeva'] })

    expect(postings[0].salary).toEqual({ min: 90000, max: 120000, currency: 'USD' })
  })

  it('a posting with no lists[] section still falls back to descriptionPlain cleanly', async () => {
    fetchSpy.mockResolvedValue(fakeFetchResponse([{ ...REAL_SHAPE_POSTING, lists: [] }]))

    const { postings } = await leverAdapter.fetchCandidates({ sites: ['veeva'] })

    expect(postings[0].requirements).toContain('Veeva Systems is a mission-driven organization')
  })

  it('a 404 for one site does not lose postings from other sites, and is surfaced as an error string', async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes('dead-site')) return fakeFetchResponse({ error: 'not found' }, false, 404)
      return fakeFetchResponse([REAL_SHAPE_POSTING])
    })

    const { postings, errors } = await leverAdapter.fetchCandidates({ sites: ['dead-site', 'veeva'] })

    expect(postings).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/dead-site/i)
  })

  it('a zero-postings site returns an empty array cleanly, not an error', async () => {
    fetchSpy.mockResolvedValue(fakeFetchResponse([]))

    const { postings, errors } = await leverAdapter.fetchCandidates({ sites: ['empty-site'] })

    expect(postings).toEqual([])
    expect(errors).toEqual([])
  })
})
