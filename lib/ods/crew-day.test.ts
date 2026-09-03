import { describe, it, expect } from 'vitest'
import {
  resolveWorkers,
  computeHours,
  buildCrewDayDraft,
  findDuplicates,
  DEFAULT_BREAK_MINUTES,
  InvalidTimeRangeError,
  TimeParseError,
  type RosterWorker,
  type CrewDayDraftRow,
  type ExistingTimeEntry,
} from './crew-day'

// Real ODS roster shape, trailing spaces and all — see
// briefs/ods-crew-day-write-path.md.
const CYRIKE: RosterWorker = { id: 'w-cyrike', firstName: 'Cyrike', lastName: 'Tiler', status: 'active' }
const EARNEST: RosterWorker = { id: 'w-earnest', firstName: 'Earnest', lastName: 'Phillipe', status: 'active' }
const LOUIS: RosterWorker = { id: 'w-louis', firstName: 'Louis', lastName: 'Beauvais', status: 'active' }
const LEONVILLE: RosterWorker = { id: 'w-leonville', firstName: 'Leonville', lastName: 'Elfra', status: 'active' }
const FANEL: RosterWorker = { id: 'w-fanel', firstName: 'Fanel', lastName: 'Etiene', status: 'active' }
const FELIX: RosterWorker = { id: 'w-felix', firstName: 'Felix', lastName: 'Mike-Awentz', status: 'active' }
const SELINE: RosterWorker = { id: 'w-seline', firstName: "Seline'", lastName: 'Emilien', status: 'active' }
const MAKENSON: RosterWorker = { id: 'w-makenson', firstName: 'Makenson ', lastName: '', status: 'active' }
const REBINS: RosterWorker = { id: 'w-rebins', firstName: 'Rebins ', lastName: '', status: 'active' }
const REBINS_BROTHER: RosterWorker = { id: 'w-rebins-brother', firstName: 'Rebins ', lastName: 'Brother', status: 'active' }
const ALAINE: RosterWorker = { id: 'w-alaine', firstName: 'Alaine', lastName: 'Prophete', status: 'inactive' }
const DAVID: RosterWorker = { id: 'w-david', firstName: 'David', lastName: 'Telusma', status: 'inactive' }

const ROSTER: RosterWorker[] = [
  CYRIKE,
  EARNEST,
  LOUIS,
  LEONVILLE,
  FANEL,
  FELIX,
  SELINE,
  MAKENSON,
  REBINS,
  REBINS_BROTHER,
  ALAINE,
  DAVID,
]

describe('resolveWorkers', () => {
  it('resolves "me" to the caller identity passed in options', () => {
    const [result] = resolveWorkers(['me'], ROSTER, { callerId: EARNEST.id })
    expect(result).toEqual({ classification: 'resolved', name: 'me', worker: EARNEST })
  })

  it('resolves "me" as unknown when no callerId is supplied', () => {
    const [result] = resolveWorkers(['me'], ROSTER, {})
    expect(result).toEqual({ classification: 'unknown', name: 'me', candidates: [] })
  })

  it('resolves "me" as unknown when the callerId does not match the roster', () => {
    const [result] = resolveWorkers(['me'], ROSTER, { callerId: 'nobody' })
    expect(result).toEqual({ classification: 'unknown', name: 'me', candidates: [] })
  })

  it('matches on first name, last name, and full name, case-insensitively', () => {
    expect(resolveWorkers(['cyrike'], ROSTER)[0]).toMatchObject({ classification: 'resolved', worker: CYRIKE })
    expect(resolveWorkers(['TILER'], ROSTER)[0]).toMatchObject({ classification: 'resolved', worker: CYRIKE })
    expect(resolveWorkers(['Cyrike Tiler'], ROSTER)[0]).toMatchObject({ classification: 'resolved', worker: CYRIKE })
  })

  it('tolerates a trailing space and empty last name on the roster row', () => {
    const [result] = resolveWorkers(['Makenson'], ROSTER)
    expect(result).toEqual({ classification: 'resolved', name: 'Makenson', worker: MAKENSON })
  })

  it('never invents a worker: "Cyril" does not fuzzy-match "Cyrike Tiler"', () => {
    const [result] = resolveWorkers(['Cyril'], ROSTER)
    expect(result).toEqual({ classification: 'unknown', name: 'Cyril', candidates: [] })
  })

  it('reports a genuinely unknown name as unknown with no candidates', () => {
    const [result] = resolveWorkers(['Dwight'], ROSTER)
    expect(result).toEqual({ classification: 'unknown', name: 'Dwight', candidates: [] })
  })

  it('flags "Rebins" as ambiguous between "Rebins " and "Rebins Brother"', () => {
    const [result] = resolveWorkers(['Rebins'], ROSTER)
    expect(result.classification).toBe('ambiguous')
    if (result.classification !== 'ambiguous') throw new Error('unreachable')
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates).toEqual(expect.arrayContaining([REBINS, REBINS_BROTHER]))
  })

  it('resolves "Rebins Brother" unambiguously via the full-name match', () => {
    const [result] = resolveWorkers(['Rebins Brother'], ROSTER)
    expect(result).toEqual({ classification: 'resolved', name: 'Rebins Brother', worker: REBINS_BROTHER })
  })

  it('prefers active workers over inactive ones', () => {
    // Alaine only exists as an inactive worker on this roster; matching her
    // name must not silently resolve, but must surface the inactive match
    // rather than reporting "unknown" with nothing to go on.
    const [result] = resolveWorkers(['Alaine'], ROSTER)
    expect(result.classification).toBe('unknown')
    if (result.classification === 'resolved') throw new Error('unreachable')
    expect(result.candidates).toEqual([ALAINE])
  })

  it('resolves multiple names in order, mixing classifications', () => {
    const results = resolveWorkers(['me', 'Cyril', 'Dwight', 'Cyrike'], ROSTER, { callerId: LOUIS.id })
    expect(results.map((r) => r.classification)).toEqual(['resolved', 'unknown', 'unknown', 'resolved'])
  })
})

describe('computeHours', () => {
  it('parses "7 to 4" (bare hours) as 07:00-16:00 -> 8.0 regular hours with a 60-minute break', () => {
    const result = computeHours({ start: '7', end: '4' })
    expect(result).toEqual({ regularHours: 8, overtimeHours: 0, breakMinutes: DEFAULT_BREAK_MINUTES })
  })

  it('parses explicit am/pm', () => {
    const result = computeHours({ start: '7am', end: '4pm' })
    expect(result).toEqual({ regularHours: 8, overtimeHours: 0, breakMinutes: 60 })
  })

  it('parses 24-hour colon times', () => {
    const result = computeHours({ start: '07:00', end: '16:00' })
    expect(result).toEqual({ regularHours: 8, overtimeHours: 0, breakMinutes: 60 })
  })

  it('parses "7:30 to 5" as 07:30-17:00 -> 8.5 regular hours', () => {
    const result = computeHours({ start: '7:30', end: '5' })
    expect(result).toEqual({ regularHours: 8.5, overtimeHours: 0, breakMinutes: 60 })
  })

  it('defaults the break to 60 minutes when unspecified', () => {
    const result = computeHours({ start: '7', end: '4' })
    expect(result.breakMinutes).toBe(60)
  })

  it('honors an explicit non-default break', () => {
    const result = computeHours({ start: '7', end: '4', breakMinutes: 30 })
    expect(result).toEqual({ regularHours: 8.5, overtimeHours: 0, breakMinutes: 30 })
  })

  it('never returns a non-zero overtimeHours, no matter how long the shift', () => {
    const result = computeHours({ start: '6am', end: '9pm' })
    expect(result.overtimeHours).toBe(0)
  })

  it('rejects an end time at or before the start time', () => {
    expect(() => computeHours({ start: '4pm', end: '7am' })).toThrow(InvalidTimeRangeError)
  })

  it('rejects an end time equal to the start time', () => {
    expect(() => computeHours({ start: '7am', end: '7am' })).toThrow(InvalidTimeRangeError)
  })

  it('rejects a break that consumes the entire shift', () => {
    expect(() => computeHours({ start: '7am', end: '8am', breakMinutes: 60 })).toThrow(InvalidTimeRangeError)
  })

  it('rejects an unparseable time', () => {
    expect(() => computeHours({ start: 'sometime', end: '4' })).toThrow(TimeParseError)
  })
})

describe('buildCrewDayDraft', () => {
  const baseInput = {
    projectId: 'proj-blue-sky',
    date: '2026-09-03',
    roster: ROSTER,
  }

  it('builds a ready draft with one row per named worker', () => {
    const result = buildCrewDayDraft({
      ...baseInput,
      names: ['me', 'Cyrike', 'Louis'],
      shift: { start: '7', end: '4' },
      callerId: EARNEST.id,
    })

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('unreachable')
    expect(result.drafts).toHaveLength(3)
    expect(result.drafts.every((d) => d.regularHours === 8 && d.overtimeHours === 0 && d.breakMinutes === 60)).toBe(
      true,
    )
    const earnestRow = result.drafts.find((d) => d.workerId === EARNEST.id)
    expect(earnestRow).toMatchObject({
      workerId: EARNEST.id,
      workerName: 'Earnest Phillipe',
      projectId: 'proj-blue-sky',
      date: '2026-09-03',
      start: '07:00',
      end: '16:00',
    })
  })

  it('applies a per-worker exception so one worker gets a different end time ("Cyril left at 2")', () => {
    const result = buildCrewDayDraft({
      ...baseInput,
      names: ['Cyrike', 'Louis'],
      shift: { start: '7', end: '4' },
      exceptions: [{ name: 'Cyrike', end: '2' }],
    })

    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('unreachable')

    const cyrikeRow = result.drafts.find((d) => d.workerId === CYRIKE.id) as CrewDayDraftRow
    const louisRow = result.drafts.find((d) => d.workerId === LOUIS.id) as CrewDayDraftRow

    expect(cyrikeRow.end).toBe('14:00')
    expect(cyrikeRow.regularHours).toBe(6) // 07:00-14:00 = 7h, minus 60min break = 6h
    expect(louisRow.end).toBe('16:00')
    expect(louisRow.regularHours).toBe(8)
  })

  it('is unusable — a discriminated union, no drafts field — when a worker is unresolved', () => {
    const result = buildCrewDayDraft({
      ...baseInput,
      names: ['Cyrike', 'Cyril'],
      shift: { start: '7', end: '4' },
    })

    expect(result.status).toBe('needs_review')
    if (result.status !== 'needs_review') throw new Error('unreachable')
    // @ts-expect-error -- 'needs_review' carries no `drafts`, by design.
    expect(result.drafts).toBeUndefined()
    expect(result.issues).toEqual([{ kind: 'worker_unknown', name: 'Cyril', candidates: [] }])
  })

  it('reports an ambiguous worker as an issue rather than guessing', () => {
    const result = buildCrewDayDraft({
      ...baseInput,
      names: ['Rebins'],
      shift: { start: '7', end: '4' },
    })

    expect(result.status).toBe('needs_review')
    if (result.status !== 'needs_review') throw new Error('unreachable')
    expect(result.issues).toEqual([
      { kind: 'worker_ambiguous', name: 'Rebins', candidates: expect.arrayContaining([REBINS, REBINS_BROTHER]) },
    ])
  })

  it('reports an invalid per-worker time as an issue instead of throwing out of the function', () => {
    const result = buildCrewDayDraft({
      ...baseInput,
      names: ['Cyrike'],
      shift: { start: '7', end: '4' },
      exceptions: [{ name: 'Cyrike', start: '4pm', end: '7am' }],
    })

    expect(result.status).toBe('needs_review')
    if (result.status !== 'needs_review') throw new Error('unreachable')
    expect(result.issues).toEqual([
      expect.objectContaining({ kind: 'invalid_time', name: 'Cyrike', start: '4pm', end: '7am' }),
    ])
  })
})

describe('findDuplicates', () => {
  const rowFor = (worker: RosterWorker, overrides: Partial<CrewDayDraftRow> = {}): CrewDayDraftRow => ({
    workerId: worker.id,
    workerName: fullNameFor(worker),
    projectId: 'proj-blue-sky',
    date: '2026-09-03',
    start: '07:00',
    end: '16:00',
    regularHours: 8,
    overtimeHours: 0,
    breakMinutes: 60,
    ...overrides,
  })

  function fullNameFor(w: RosterWorker): string {
    return w.lastName ? `${w.firstName.trim()} ${w.lastName.trim()}` : w.firstName.trim()
  }

  it('finds drafts that collide on (worker, project, date) with an existing entry', () => {
    const drafts = [rowFor(CYRIKE), rowFor(LOUIS)]
    const existing: ExistingTimeEntry[] = [{ workerId: CYRIKE.id, projectId: 'proj-blue-sky', date: '2026-09-03' }]

    expect(findDuplicates(drafts, existing)).toEqual([drafts[0]])
  })

  it('does not flag the same worker on a different date or project as a duplicate', () => {
    const drafts = [rowFor(CYRIKE)]
    const existing: ExistingTimeEntry[] = [
      { workerId: CYRIKE.id, projectId: 'proj-blue-sky', date: '2026-09-02' },
      { workerId: CYRIKE.id, projectId: 'proj-other', date: '2026-09-03' },
    ]

    expect(findDuplicates(drafts, existing)).toEqual([])
  })

  it('returns an empty array — refusing to guess a partial match — when nothing collides', () => {
    const drafts = [rowFor(LOUIS)]
    expect(findDuplicates(drafts, [])).toEqual([])
  })

  it('flags Omar re-reporting the same crew day as every worker duplicating', () => {
    const drafts = [rowFor(CYRIKE), rowFor(LOUIS), rowFor(EARNEST)]
    const existing: ExistingTimeEntry[] = drafts.map((d) => ({
      workerId: d.workerId,
      projectId: d.projectId,
      date: d.date,
    }))

    expect(findDuplicates(drafts, existing)).toEqual(drafts)
  })
})
