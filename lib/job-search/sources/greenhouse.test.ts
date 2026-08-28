import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { greenhouseAdapter } from './greenhouse'

/**
 * Regression fixtures for the CAY-192 audit (PR #196). Verified live
 * against boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 * (2026-08-28): `content` comes back double-HTML-entity-encoded (a real
 * GitLab posting's raw JSON contained the literal escaped text
 * "&lt;strong&gt;", which decodes to "&lt;strong&gt;" as a literal
 * string — NOT an actual <strong> tag). The original stripHtml
 * (`/<[^>]+>/g`) matched nothing on that shape at all — proved by running
 * the exact regex against real captured content and finding byte-identical
 * input/output length. The fixture below reproduces that real shape.
 */
function fakeFetchResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response
}

// Real shape: double-encoded, includes an inline &lt;strong&gt; splitting a
// work-authorization phrase, and a real &amp;nbsp; word-glue case.
const REAL_SHAPE_CONTENT =
  '&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;Join our values&amp;nbsp;driven team.&lt;/p&gt;' +
  '&lt;p&gt;Applicants must be a U.S. &lt;strong&gt;citizen&lt;/strong&gt; due to federal contract requirements.&lt;/p&gt;&lt;/div&gt;'

const REAL_SHAPE_JOB = {
  id: 1,
  title: 'Software Engineer I',
  updated_at: '2026-08-10T16:52:46-04:00',
  absolute_url: 'https://job-boards.greenhouse.io/exampleco/jobs/1',
  requisition_id: 'REQ-1',
  location: { name: 'Remote, United States' },
  content: REAL_SHAPE_CONTENT,
}

describe('greenhouseAdapter — decodes real double-encoded content (#196 audit)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('strips real double-encoded HTML so the policy gate can actually see the disqualifying phrase', async () => {
    fetchSpy.mockResolvedValue(fakeFetchResponse({ jobs: [REAL_SHAPE_JOB] }))

    const { postings } = await greenhouseAdapter.fetchCandidates({ boards: ['exampleco'] })

    expect(postings).toHaveLength(1)
    const { requirements } = postings[0]
    expect(requirements).not.toMatch(/&lt;|&gt;|&amp;/)
    // This is the exact regression this audit found: pre-fix, the
    // inline &lt;strong&gt;...&lt;/strong&gt; markup around "citizen" sat
    // directly between "U.S." and "citizen" with no whitespace consumed
    // by \s+, breaking the citizenship-required pattern match entirely.
    expect(requirements).toMatch(/must be a u\.s\.\s+citizen/i)
    // The &amp;nbsp; word-glue case: "values&amp;nbsp;driven" must decode
    // to "values driven", not stay glued with zero whitespace.
    expect(requirements).toMatch(/values driven team/i)
  })

  it('sets description and requirements from the same cleaned text', async () => {
    fetchSpy.mockResolvedValue(fakeFetchResponse({ jobs: [REAL_SHAPE_JOB] }))

    const { postings } = await greenhouseAdapter.fetchCandidates({ boards: ['exampleco'] })

    expect(postings[0].description).toBe(postings[0].requirements)
  })

  it('a fetch failure for one board does not lose postings from other boards, and is surfaced as an error', async () => {
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes('dead-board')) return fakeFetchResponse({ error: 'not found' }, false, 404)
      return fakeFetchResponse({ jobs: [REAL_SHAPE_JOB] })
    })

    const { postings, errors } = await greenhouseAdapter.fetchCandidates({ boards: ['dead-board', 'exampleco'] })

    expect(postings).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/dead-board/i)
  })

  it('a board with zero jobs returns an empty array cleanly', async () => {
    fetchSpy.mockResolvedValue(fakeFetchResponse({ jobs: [] }))

    const { postings, errors } = await greenhouseAdapter.fetchCandidates({ boards: ['empty-board'] })

    expect(postings).toEqual([])
    expect(errors).toEqual([])
  })

  it('falls back to the job\'s own internal id when the company has not set a requisition_id', async () => {
    fetchSpy.mockResolvedValue(fakeFetchResponse({ jobs: [{ ...REAL_SHAPE_JOB, requisition_id: null, id: 8503792002 }] }))

    const { postings } = await greenhouseAdapter.fetchCandidates({ boards: ['exampleco'] })

    // Never null — dedupe.ts's fallback (company+title+location) would
    // otherwise silently merge two distinct reqs sharing an identical
    // title/location string.
    expect(postings[0].requisitionId).toBe('8503792002')
  })

  it('infers remote/hybrid/on_site from real-world location strings without crashing on missing location', async () => {
    fetchSpy.mockResolvedValue(
      fakeFetchResponse({
        jobs: [
          { ...REAL_SHAPE_JOB, id: 1, location: { name: 'Remote, Canada; Remote, United States' } },
          { ...REAL_SHAPE_JOB, id: 2, location: null, offices: [] },
        ],
      }),
    )

    const { postings } = await greenhouseAdapter.fetchCandidates({ boards: ['exampleco'] })

    expect(postings[0].remoteType).toBe('remote')
    expect(postings[1].remoteType).toBe('unknown')
    expect(postings[1].location).toBeNull()
  })
})
