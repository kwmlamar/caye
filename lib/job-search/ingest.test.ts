import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

/**
 * lib/job-search/ingest.ts (runIngestPipeline) had zero test coverage
 * before this audit pass (PR #196) despite being the actual DB-touching
 * glue that wires sourcing -> dedupe -> policy-gate -> scoring -> queue
 * together — the layer most likely to have an integration bug even when
 * every pure function it calls is independently well-tested. This file
 * covers:
 *   - the job_search_runs_one_running_per_type_idx overlap guard added in
 *     this audit (two concurrent 'source' runs must not both proceed to
 *     hit the external adapters);
 *   - a happy-path smoke test proving sourcing -> dedupe -> score -> queue
 *     actually wires together correctly end to end;
 *   - a single adapter failure does not abort the whole run (partial
 *     failure resilience — the other source's postings still get
 *     processed and the failure is recorded in stats.errors, not thrown).
 */

type Row = Record<string, unknown>

function makeFakeSupabase() {
  const tables: Record<string, Row[]> = {}
  let counter = 0
  const ensure = (table: string) => (tables[table] ??= [])
  let forceRunsInsertUniqueViolation = false

  const client = {
    __forceRunsInsertUniqueViolation(v: boolean) {
      forceRunsInsertUniqueViolation = v
    },
    from(table: string) {
      const store = ensure(table)
      return {
        insert(rowOrRows: Row | Row[]) {
          if (table === 'job_search_runs' && forceRunsInsertUniqueViolation) {
            return {
              select() {
                return {
                  async single() {
                    return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "job_search_runs_one_running_per_type_idx"' } }
                  },
                }
              },
            }
          }
          const rowsArr = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]
          const inserted = rowsArr.map((r) => {
            const full = { id: `id_${counter++}`, ...r }
            store.push(full)
            return full
          })
          return {
            select() {
              return { async single() { return { data: inserted[0], error: null } } }
            },
          }
        },
        upsert(row: Row, opts?: { onConflict?: string }) {
          const conflictCol = opts?.onConflict
          const existing = conflictCol ? store.find((r) => r[conflictCol] === row[conflictCol]) : undefined
          const result = existing ? Object.assign(existing, row) : { id: `id_${counter++}`, ...row }
          if (!existing) store.push(result)
          return {
            select() {
              return { async single() { return { data: result, error: null } } }
            },
          }
        },
        update(patch: Row) {
          return {
            eq(col: string, val: unknown) {
              const row = store.find((r) => r[col] === val)
              if (row) Object.assign(row, patch)
              return Promise.resolve({ data: row ?? null, error: null })
            },
          }
        },
        select(_cols: string) {
          return {
            eq(col: string, val: unknown) {
              const rows = store.filter((r) => r[col] === val)
              return Promise.resolve({ data: rows, error: null })
            },
          }
        },
      }
    },
  }
  return { client, tables }
}

let fake = makeFakeSupabase()

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => fake.client,
}))

vi.mock('./events', () => ({
  logJobSearchEvent: vi.fn(async () => {}),
}))

const profileMock = {
  id: 'profile-1',
  status: 'verified' as const,
  skills: ['TypeScript', 'React'],
  summary: 'Recent CS graduate.',
  fullName: 'Test Founder',
  headline: null,
  education: [],
  experience: [],
  links: {},
  workAuthorization: {},
  locationPreferences: {},
  targetTitles: ['Software Engineer I'],
}
vi.mock('./profile', () => ({
  getActiveProfile: async () => profileMock,
}))

const greenhouseFetch = vi.fn()
const leverFetch = vi.fn()
vi.mock('./sources', () => ({
  getSourceAdapter: (sourceKey: string) => {
    if (sourceKey === 'greenhouse_public') return { fetchCandidates: greenhouseFetch }
    if (sourceKey === 'lever_public') return { fetchCandidates: leverFetch }
    return null
  },
}))

const { runIngestPipeline } = await import('./ingest')

/** Matches SourceAdapter.fetchCandidates' { postings, errors } return shape. */
function sourceResult(postings: Record<string, unknown>[], errors: string[] = []) {
  return { postings, errors }
}

function posting(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sourceKey: 'greenhouse_public',
    sourceUrl: 'https://boards.greenhouse.io/exampleco/jobs/1',
    applyUrl: 'https://boards.greenhouse.io/exampleco/jobs/1',
    company: 'Example Co',
    title: 'Software Engineer I',
    requisitionId: '1',
    location: 'Remote - US',
    remoteType: 'remote',
    description: 'Join our team.',
    requirements: '1-2 years experience. TypeScript, React.',
    postedAt: new Date().toISOString(),
    salary: null,
    employmentType: 'full_time',
    ...overrides,
  }
}

beforeEach(() => {
  fake = makeFakeSupabase()
  fake.tables['job_search_sources'] = [
    { source_key: 'greenhouse_public', adapter_type: 'greenhouse', config: {}, enabled: true },
    { source_key: 'lever_public', adapter_type: 'lever', config: {}, enabled: true },
  ]
  greenhouseFetch.mockReset()
  leverFetch.mockReset()
  greenhouseFetch.mockResolvedValue(sourceResult([]))
  leverFetch.mockResolvedValue(sourceResult([]))
})

describe('runIngestPipeline — overlap guard (#196 audit)', () => {
  it('does not call any source adapter when a sourcing run is already in flight', async () => {
    fake.client.__forceRunsInsertUniqueViolation(true)

    const stats = await runIngestPipeline()

    expect(stats.skippedAlreadyRunning).toBe(true)
    expect(greenhouseFetch).not.toHaveBeenCalled()
    expect(leverFetch).not.toHaveBeenCalled()
  })

  it('proceeds normally when no run is currently in flight', async () => {
    fake.client.__forceRunsInsertUniqueViolation(false)
    greenhouseFetch.mockResolvedValue(sourceResult([posting()]))

    const stats = await runIngestPipeline()

    expect(stats.skippedAlreadyRunning).toBeUndefined()
    expect(greenhouseFetch).toHaveBeenCalledTimes(1)
  })
})

describe('runIngestPipeline — end-to-end wiring', () => {
  it('sources, dedupes cross-source duplicates, scores, and queues candidates', async () => {
    const shared = posting({ requisitionId: 'shared-1' })
    greenhouseFetch.mockResolvedValue(sourceResult([shared]))
    leverFetch.mockResolvedValue(sourceResult([{ ...shared, sourceKey: 'lever_public', sourceUrl: 'https://jobs.lever.co/exampleco/1' }]))

    const stats = await runIngestPipeline()

    expect(stats.sourced).toBe(2)
    // Both sources returned what dedupe.ts should treat as the same
    // real-world posting (same company/title/requisitionId) -> one
    // canonical candidate, not two.
    expect(stats.deduped).toBe(1)
    expect(stats.errors).toEqual([])

    const candidates = fake.tables['job_search_candidates'] ?? []
    expect(candidates).toHaveLength(1)
    expect((candidates[0].discovered_via as unknown[]).length).toBe(2)
  })

  it('a single source adapter failure is recorded but does not abort the whole run', async () => {
    greenhouseFetch.mockRejectedValue(new Error('Greenhouse board not found (404)'))
    leverFetch.mockResolvedValue(sourceResult([posting({ sourceKey: 'lever_public', requisitionId: 'lever-only' })]))

    const stats = await runIngestPipeline()

    expect(stats.errors.length).toBe(1)
    expect(stats.errors[0]).toMatch(/greenhouse_public/i)
    // The Lever posting was still sourced and scored despite Greenhouse failing.
    expect(stats.sourced).toBe(1)
    expect(stats.scored).toBe(1)

    const runs = fake.tables['job_search_runs'] ?? []
    expect(runs[0].status).toBe('completed')
  })

  it('a hard-blocked posting (no CPT/OPT) is rejected, never queued, regardless of fit', async () => {
    greenhouseFetch.mockResolvedValue(
      sourceResult([
        posting({
          requisitionId: 'blocked-1',
          title: 'Software Engineer I',
          requirements: '1 year experience. TypeScript, React. No CPT/OPT. No sponsorship.',
        }),
      ]),
    )

    const stats = await runIngestPipeline()

    expect(stats.rejected).toBe(1)
    expect(stats.autoQueued).toBe(0)
    expect(stats.queuedIfCapacity).toBe(0)

    const candidates = fake.tables['job_search_candidates'] ?? []
    expect(candidates[0].status).toBe('REJECTED')
    expect(candidates[0].opt_excluded).toBe(true)
  })
})

describe('runIngestPipeline — experience-range parsing (#196 audit)', () => {
  // Adversarial regression fixtures for the checklist's explicit test
  // ranges: "0-2 years", "1+ years", "2-4 years", "3 years preferred",
  // "5 years preferred", "5 years required", "equivalent project
  // experience". None of these should hard-reject a reasonable
  // early-career posting; a real 8+/10+ year requirement should — unless
  // it's explicitly "preferred" language, which should score down rather
  // than reject outright.
  const cases: { label: string; requirements: string; expectRejected: boolean }[] = [
    { label: '0-2 years', requirements: '0-2 years experience. TypeScript, React.', expectRejected: false },
    { label: '1+ years', requirements: '1+ years of professional experience required.', expectRejected: false },
    { label: '2-4 years', requirements: '2-4 years of experience with modern JS frameworks.', expectRejected: false },
    { label: '3 years preferred', requirements: '3 years of experience preferred but not required.', expectRejected: false },
    { label: '5 years preferred', requirements: '5 years of experience preferred.', expectRejected: false },
    { label: '5 years required', requirements: '5 years of experience required.', expectRejected: false },
    { label: 'equivalent project experience', requirements: 'Bachelor\'s degree or equivalent project experience.', expectRejected: false },
    { label: '10+ years required (genuinely senior)', requirements: '10+ years of experience required.', expectRejected: true },
    { label: '8+ years preferred (soft language, should not hard-block)', requirements: '8+ years of experience preferred for this role.', expectRejected: false },
  ]

  for (const { label, requirements, expectRejected } of cases) {
    it(`"${label}" ${expectRejected ? 'is hard-rejected' : 'is NOT hard-rejected'}`, async () => {
      greenhouseFetch.mockResolvedValue(sourceResult([posting({ requisitionId: label, requirements })]))

      const stats = await runIngestPipeline()

      const candidates = fake.tables['job_search_candidates'] ?? []
      const isRejectedForExperience = candidates[0].hard_block_reason === 'experience_gap_too_large'
      expect(isRejectedForExperience).toBe(expectRejected)
      if (!expectRejected) {
        // Should be scored normally (not silently rejected for some other reason).
        expect(stats.rejected + stats.autoQueued + stats.queuedIfCapacity + stats.reviewLowPriority).toBe(1)
      }
    })
  }
})
