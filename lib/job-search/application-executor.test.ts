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
        upsert(row: Row, opts?: { onConflict?: string }) {
          const conflictCol = opts?.onConflict
          const existing = conflictCol ? store.find((r) => r[conflictCol] === row[conflictCol]) : undefined
          const result = existing ? Object.assign(existing, row) : { id: `id_${counter++}`, ...row }
          if (!existing) store.push(result)
          return {
            select(_cols: string) {
              return { async single() { return { data: result, error: null } } }
            },
          }
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
  targetTitles: [],
}

const factsMock = vi.fn()
vi.mock('./profile', () => ({
  getActiveProfile: async () => profileMock,
  getActiveFacts: async () => factsMock(),
}))

const { prepareApplication, evaluateExecutionSignal } = await import('./application-executor')

const resumeVariant = { id: 'variant-1', variantKey: 'full_stack' as const, title: 'Software Engineer / Full Stack', summary: 'Recent CS graduate.', sections: {} }

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
})
