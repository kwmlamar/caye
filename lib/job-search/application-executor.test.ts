import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

type Row = Record<string, unknown>

function makeFakeSupabase() {
  const tables: Record<string, Row[]> = {}
  let counter = 0
  const ensure = (table: string) => (tables[table] ??= [])

  const client = {
    from(table: string) {
      const store = ensure(table)
      return {
        select(_cols: string) {
          let filtered = store
          const query = {
            eq(col: string, val: unknown) {
              filtered = filtered.filter((row) => row[col] === val)
              return query
            },
            async maybeSingle() {
              return { data: filtered[0] ?? null, error: null }
            },
          }
          return query
        },
        upsert(row: Row, opts?: { onConflict?: string }) {
          const conflictCols = opts?.onConflict?.split(',').map((col) => col.trim()).filter(Boolean) ?? []
          const existing = conflictCols.length > 0
            ? store.find((candidate) => conflictCols.every((col) => candidate[col] === row[col]))
            : undefined
          const result = existing ? Object.assign(existing, row) : { id: `id_${counter++}`, ...row }
          if (!existing) store.push(result)
          const promiseResult = Promise.resolve({ data: result, error: null })
          return Object.assign(promiseResult, {
            select(_cols: string) {
              return { async single() { return { data: result, error: null } } }
            },
          })
        },
        insert(rowOrRows: Row | Row[]) {
          const rowsArr = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]
          const inserted = rowsArr.map((r) => {
            const full = { id: `id_${counter++}`, ...r }
            store.push(full)
            return full
          })
          return Promise.resolve({ data: inserted, error: null })
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

const settingsMock = vi.fn()
vi.mock('./settings', () => ({
  getJobSearchSettings: () => settingsMock(),
}))

const profileMock = {
  id: 'profile-1',
  status: 'verified' as 'needs_verification' | 'verified',
  skills: ['TypeScript', 'React'],
  summary: 'Recent CS graduate.',
  fullName: 'Test Founder',
  headline: null,
  education: [],
  experience: [],
  links: {},
  workAuthorization: {},
  locationPreferences: {},
  targetTitles: [],
}

const factsMock = vi.fn()
const profileFn = vi.fn(() => profileMock)
vi.mock('./profile', () => ({
  getActiveProfile: async () => profileFn(),
  getActiveFacts: async () => factsMock(),
}))

const { prepareApplication, evaluateExecutionSignal } = await import('./application-executor')

const resumeVariant = {
  id: 'variant-1',
  variantKey: 'full_stack' as const,
  title: 'Software Engineer / Full Stack',
  summary: 'Recent CS graduate.',
  sections: {},
  status: 'verified' as const,
}

const supportVariant = {
  ...resumeVariant,
  id: 'variant-support',
  variantKey: 'it_support' as const,
  title: 'IT Support & Technical Systems',
  summary: 'Computer Science graduate and hands-on technical builder seeking an IT Support Technician role.',
}

function candidate(overrides: Partial<Parameters<typeof prepareApplication>[0]> = {}) {
  return {
    id: `candidate-${Math.random()}`,
    company: 'Example Co',
    title: 'Software Engineer I',
    applyUrl: 'https://boards.greenhouse.io/exampleco/jobs/123',
    skills: ['TypeScript'],
    requiredFields: [],
    ...overrides,
  }
}

beforeEach(() => {
  fake = makeFakeSupabase()
  settingsMock.mockReset()
  factsMock.mockReset()
  factsMock.mockResolvedValue([])
  profileFn.mockReset()
  profileFn.mockReturnValue(profileMock)
})

describe('evaluateExecutionSignal — never bypasses (#192)', () => {
  it('CAPTCHA always stops, never a bypass', () => {
    const result = evaluateExecutionSignal({ kind: 'captcha_detected' })
    expect(result.outcome).toBe('needs_human')
  })

  it('an unknown required application answer routes to human review', () => {
    const result = evaluateExecutionSignal({ kind: 'unknown_required_field', field: 'why_do_you_want_this_role' })
    expect(result.outcome).toBe('needs_human')
  })

  it('anti-bot detection stops automation', () => {
    expect(evaluateExecutionSignal({ kind: 'anti_bot_detected' }).outcome).toBe('needs_human')
  })

  it('a clear signal reports clear (but this alone never causes a submission in this build)', () => {
    expect(evaluateExecutionSignal({ kind: 'clear' }).outcome).toBe('clear')
  })
})

describe('prepareApplication — safety boundaries (#192)', () => {
  it('never automates against a LinkedIn apply URL', async () => {
    settingsMock.mockResolvedValue({ paused: false })
    const result = await prepareApplication(candidate({ applyUrl: 'https://www.linkedin.com/jobs/view/999' }), resumeVariant)
    expect(result.outcome).toBe('prohibited_platform')
  })

  it('never automates against an Indeed apply URL', async () => {
    settingsMock.mockResolvedValue({ paused: false })
    const result = await prepareApplication(candidate({ applyUrl: 'https://apply.indeed.com/apply/abc' }), resumeVariant)
    expect(result.outcome).toBe('prohibited_platform')
  })

  it('an unresolved required application answer routes to NEEDS_HUMAN', async () => {
    settingsMock.mockResolvedValue({ paused: false })
    factsMock.mockResolvedValue([])
    const result = await prepareApplication(
      candidate({ requiredFields: [{ key: 'sponsorship', question: 'Will you require sponsorship?', category: 'work_authorization' }] }),
      resumeVariant,
    )
    expect(result.outcome).toBe('needs_human')
  })

  it('never reaches SUBMITTED even for a fully-answerable, non-prohibited application', async () => {
    settingsMock.mockResolvedValue({ paused: false })
    const result = await prepareApplication(candidate(), resumeVariant)
    expect(result.outcome).toBe('needs_human')
    if (result.outcome === 'needs_human') {
      expect(result.reason).toMatch(/not implemented/i)
    }
  })

  it('pause prevents new application execution', async () => {
    settingsMock.mockResolvedValue({ paused: true })
    const result = await prepareApplication(candidate(), resumeVariant)
    expect(result.outcome).toBe('skipped_paused')
  })

  it('is idempotent: re-preparing the same candidate does not create a second application row', async () => {
    settingsMock.mockResolvedValue({ paused: false })
    const oneCandidate = candidate({ id: 'stable-candidate-id' })

    await prepareApplication(oneCandidate, resumeVariant)
    await prepareApplication(oneCandidate, resumeVariant)

    const applications = fake.tables['job_search_applications'] ?? []
    const forThisCandidate = applications.filter((row) => row.candidate_id === 'stable-candidate-id')
    expect(forThisCandidate).toHaveLength(1)
  })

  it('re-preparing replaces generated artifacts instead of duplicating them', async () => {
    settingsMock.mockResolvedValue({ paused: false })
    const oneCandidate = candidate({ id: 'artifact-stable-candidate' })

    await prepareApplication(oneCandidate, resumeVariant)
    await prepareApplication(oneCandidate, resumeVariant)

    const artifacts = fake.tables['job_search_generated_artifacts'] ?? []
    expect(artifacts).toHaveLength(2)
    expect(artifacts.map((row) => row.artifact_type).sort()).toEqual(['cover_letter', 'resume'])
  })

  it('re-preparing with a newly selected support resume updates the same application and both artifacts', async () => {
    settingsMock.mockResolvedValue({ paused: false })
    const oneCandidate = candidate({ id: 'support-candidate', title: 'Technical Support Engineer' })

    const first = await prepareApplication(oneCandidate, resumeVariant)
    const second = await prepareApplication(oneCandidate, supportVariant)

    expect(first.outcome).toBe('needs_human')
    expect(second.outcome).toBe('needs_human')
    if (first.outcome === 'needs_human' && second.outcome === 'needs_human') {
      expect(second.applicationId).toBe(first.applicationId)
    }

    const applications = fake.tables['job_search_applications'] ?? []
    expect(applications).toHaveLength(1)
    expect(applications[0].resume_variant_id).toBe('variant-support')

    const artifacts = fake.tables['job_search_generated_artifacts'] ?? []
    expect(artifacts).toHaveLength(2)
    expect(artifacts.every((row) => row.resume_variant_id === 'variant-support')).toBe(true)
  })

  it('refuses to re-prepare a submitted application and preserves its terminal status', async () => {
    settingsMock.mockResolvedValue({ paused: false })
    const oneCandidate = candidate({ id: 'submitted-candidate' })

    await prepareApplication(oneCandidate, resumeVariant)
    const application = (fake.tables['job_search_applications'] ?? [])[0]
    application.status = 'SUBMITTED'

    await expect(prepareApplication(oneCandidate, supportVariant)).rejects.toThrow(/Refusing to re-prepare.*SUBMITTED/i)
    expect(application.status).toBe('SUBMITTED')
    expect(application.resume_variant_id).toBe('variant-1')
  })

  it('is idempotent under real concurrency: two simultaneous prepare calls for the same candidate never create two application rows', async () => {
    settingsMock.mockResolvedValue({ paused: false })
    const oneCandidate = candidate({ id: 'concurrent-candidate-id' })

    const [resultA, resultB] = await Promise.all([
      prepareApplication(oneCandidate, resumeVariant),
      prepareApplication(oneCandidate, resumeVariant),
    ])

    expect(resultA.outcome).toBe('needs_human')
    expect(resultB.outcome).toBe('needs_human')

    const applications = fake.tables['job_search_applications'] ?? []
    const forThisCandidate = applications.filter((row) => row.candidate_id === 'concurrent-candidate-id')
    expect(forThisCandidate).toHaveLength(1)

    if (resultA.outcome === 'needs_human' && resultB.outcome === 'needs_human') {
      expect(resultA.applicationId).toBe(resultB.applicationId)
    }
  })
})

describe('prepareApplication — refuses unverified source material (#196 audit)', () => {
  it('never generates artifacts from an unverified founder profile', async () => {
    settingsMock.mockResolvedValue({ paused: false })
    profileFn.mockReturnValue({ ...profileMock, status: 'needs_verification' as const })

    const result = await prepareApplication(candidate(), resumeVariant)

    expect(result.outcome).toBe('skipped_unverified_source')
    const artifacts = fake.tables['job_search_generated_artifacts'] ?? []
    expect(artifacts).toHaveLength(0)
  })

  it('never generates artifacts from an unverified resume variant', async () => {
    settingsMock.mockResolvedValue({ paused: false })
    const unverifiedVariant = { ...resumeVariant, status: 'needs_verification' as const }

    const result = await prepareApplication(candidate(), unverifiedVariant)

    expect(result.outcome).toBe('skipped_unverified_source')
    const artifacts = fake.tables['job_search_generated_artifacts'] ?? []
    expect(artifacts).toHaveLength(0)
  })

  it('proceeds normally once both profile and resume variant are verified', async () => {
    settingsMock.mockResolvedValue({ paused: false })
    profileFn.mockReturnValue({ ...profileMock, status: 'verified' as const })

    const result = await prepareApplication(candidate(), resumeVariant)

    expect(result.outcome).not.toBe('skipped_unverified_source')
    const artifacts = fake.tables['job_search_generated_artifacts'] ?? []
    expect(artifacts.length).toBeGreaterThan(0)
  })
})
