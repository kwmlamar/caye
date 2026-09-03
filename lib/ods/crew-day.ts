/**
 * Pure reasoning layer for turning one WhatsApp crew-day report into
 * timesheet rows, per `briefs/ods-crew-day-write-path.md`.
 *
 * Everything here takes data in and returns data out. No Supabase, no
 * fetch, no `server-only` — the caller (an agent tool, later) is
 * responsible for fetching the roster/projects/existing entries and for
 * every I/O side effect. That split is what makes the hard part —
 * "who is Cyril, and did Omar already report this day" — exhaustively
 * testable without a database.
 *
 * Two invariants this file exists to protect, straight from the brief:
 *
 *  - Never invent a worker. A fuzzy match that guesses wrong puts one
 *    man's hours on another man's pay, so name resolution only ever
 *    returns `resolved | ambiguous | unknown` — it never picks for you.
 *  - Never compute overtime. No overtime policy is recorded anywhere in
 *    ODS, so `overtimeHours` is always `0`, unconditionally, with no
 *    parameter that lets a caller override it.
 */

// ---------------------------------------------------------------------------
// Roster / worker resolution
// ---------------------------------------------------------------------------

/**
 * The roster shape this module needs — a narrow, structural subset of
 * whatever the caller's adapter returns (e.g. `BedrockWorker`), so this
 * file never has to import from `lib/domain-adapters/bedrock`.
 *
 * Live ODS data includes rows like `{ firstName: 'Makenson ', lastName: '' }`
 * — a trailing space and no last name — so every comparison here trims
 * before matching. Never trust the roster's own formatting.
 */
export interface RosterWorker {
  id: string
  firstName: string
  lastName: string
  status: string | null
}

export interface ResolveWorkersOptions {
  /**
   * The worker id "me" resolves to — the sender's own identity, established
   * elsewhere (e.g. by mapping Omar's WhatsApp phone number to a worker
   * profile). If absent, or if it doesn't match anyone on the roster passed
   * in, "me" resolves as `unknown` rather than being silently dropped.
   */
  callerId?: string
}

export interface WorkerResolutionResolved {
  classification: 'resolved'
  /** The name exactly as it appeared in the input (trimmed). */
  name: string
  worker: RosterWorker
}

export interface WorkerResolutionAmbiguous {
  classification: 'ambiguous'
  name: string
  /** Every active worker the name matched. Never guess among these. */
  candidates: RosterWorker[]
}

export interface WorkerResolutionUnknown {
  classification: 'unknown'
  name: string
  /**
   * Usually empty. Non-empty only when the name matched roster entries that
   * are all inactive — surfaced here rather than silently dropped, so the
   * caller can say "David Telusma matched, but he's marked inactive" instead
   * of "unknown name."
   */
  candidates: RosterWorker[]
}

export type WorkerResolution = WorkerResolutionResolved | WorkerResolutionAmbiguous | WorkerResolutionUnknown

function normalizeNamePart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function isActive(worker: RosterWorker): boolean {
  return (worker.status ?? '').trim().toLowerCase() === 'active'
}

/** `"Makenson "` + `""` -> `"Makenson"`; `"Rebins "` + `"Brother"` -> `"Rebins Brother"`. */
function fullName(worker: RosterWorker): string {
  const first = worker.firstName.trim()
  const last = worker.lastName.trim()
  return last ? `${first} ${last}` : first
}

/**
 * Exact match (after trim + casefold) against first name, last name, or full
 * name. Deliberately exact, not fuzzy: a fuzzy match is exactly the thing
 * that would let "Cyril" silently resolve to "Cyrike Tiler". If they're the
 * same person, someone says so and the caller supplies the mapping — this
 * function never infers it.
 */
function matchesRosterEntry(query: string, worker: RosterWorker): boolean {
  const q = normalizeNamePart(query)
  if (q === '') return false
  const first = normalizeNamePart(worker.firstName)
  const last = normalizeNamePart(worker.lastName)
  const full = normalizeNamePart(fullName(worker))
  return q === first || (last !== '' && q === last) || q === full
}

/**
 * Map informal names ("me", "Cyril", "Dwight") to roster rows.
 *
 * One classification per input name, in the same order as `names`. Never
 * collapses `ambiguous` down to a guess — "Rebins" genuinely matches both
 * `Rebins ` and `Rebins Brother` on ODS's real roster, and both must come
 * back so the caller asks rather than picking one.
 */
export function resolveWorkers(
  names: string[],
  roster: RosterWorker[],
  options: ResolveWorkersOptions = {},
): WorkerResolution[] {
  return names.map((rawName): WorkerResolution => {
    const name = rawName.trim()

    if (normalizeNamePart(name) === 'me') {
      const callerWorker = options.callerId ? roster.find((w) => w.id === options.callerId) : undefined
      if (!callerWorker) return { classification: 'unknown', name, candidates: [] }
      return { classification: 'resolved', name, worker: callerWorker }
    }

    const matches = roster.filter((w) => matchesRosterEntry(name, w))
    if (matches.length === 0) return { classification: 'unknown', name, candidates: [] }

    const active = matches.filter(isActive)
    if (active.length === 1) return { classification: 'resolved', name, worker: active[0] }
    if (active.length > 1) return { classification: 'ambiguous', name, candidates: active }

    // Every match is inactive. Not resolvable without asking Jay/Omar
    // whether an inactive worker is really who's meant — but say so with
    // the candidate(s) attached rather than reporting "unknown" as if
    // nothing matched at all.
    return { classification: 'unknown', name, candidates: matches }
  })
}

// ---------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------

/** Every one of ODS's 3,883 existing timesheet entries uses a 60-minute break. */
export const DEFAULT_BREAK_MINUTES = 60

export interface ComputeHoursInput {
  /** Informal start-of-shift time: `"7"`, `"7am"`, `"07:00"`, `"7:30"`. */
  start: string
  /** Informal end-of-shift time: `"4"`, `"4pm"`, `"16:00"`. */
  end: string
  /** Defaults to {@link DEFAULT_BREAK_MINUTES} (60) if omitted. */
  breakMinutes?: number
}

export interface ComputedHours {
  regularHours: number
  /** Always `0`. See the module doc comment — this is not a bug. */
  overtimeHours: 0
  /** Echoes back whatever break was actually applied, including the default. */
  breakMinutes: number
}

/** A time field couldn't be parsed as a clock time at all. */
export class TimeParseError extends Error {
  constructor(public readonly value: string) {
    super(`Could not parse "${value}" as a time.`)
    this.name = 'TimeParseError'
  }
}

/**
 * A well-formed but unusable range: end at or before start (after applying
 * the am/pm heuristic below), or a break that consumes the entire shift.
 * ODS's live data contains one real `07:00:00-04:00:00` row — this class
 * exists so that corruption is rejected here rather than silently turned
 * into a negative or wrapped-around day.
 */
export class InvalidTimeRangeError extends Error {
  constructor(
    public readonly start: string,
    public readonly end: string,
  ) {
    super(`End time ("${end}") is not after start time ("${start}") once the break is applied.`)
    this.name = 'InvalidTimeRangeError'
  }
}

interface ParsedClockTime {
  hour: number
  minute: number
}

/**
 * Parse one informal clock-time field.
 *
 * Rules, in order:
 *  1. Explicit `am`/`pm` (`"7am"`, `"7:30pm"`) is always honored literally.
 *  2. A colon time with no am/pm (`"07:00"`, `"16:00"`) is read as a 24-hour
 *     value UNLESS the hour is in the ambiguous 1-11 range, in which case
 *     rule 3 applies to it exactly as if it had no colon.
 *  3. A bare hour with no am/pm and no colon, in the ambiguous 1-11 range,
 *     is resolved by construction-day convention: a `start` field is
 *     assumed morning (left as-is), an `end` field is assumed afternoon
 *     (12 added). This is exactly the "`7 to 4` means 07:00-16:00" rule
 *     from the brief. Hour `0` and hours `12`-`23` are already unambiguous
 *     24-hour values and pass through unchanged in both positions.
 */
function parseTimeOfDay(raw: string, part: 'start' | 'end'): ParsedClockTime {
  const value = raw.trim().toLowerCase()

  let match = value.match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)$/)
  if (match) {
    let hour = Number.parseInt(match[1], 10)
    const minute = match[2] ? Number.parseInt(match[2], 10) : 0
    const meridiem = match[3]
    if (hour < 1 || hour > 12) throw new TimeParseError(raw)
    if (meridiem === 'pm' && hour !== 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
    return { hour, minute }
  }

  match = value.match(/^(\d{1,2}):([0-5]\d)$/)
  if (match) {
    const hour = Number.parseInt(match[1], 10)
    const minute = Number.parseInt(match[2], 10)
    if (hour > 23) throw new TimeParseError(raw)
    return { hour: applyConstructionDayHeuristic(hour, part), minute }
  }

  match = value.match(/^(\d{1,2})$/)
  if (match) {
    const hour = Number.parseInt(match[1], 10)
    if (hour > 23) throw new TimeParseError(raw)
    return { hour: applyConstructionDayHeuristic(hour, part), minute: 0 }
  }

  throw new TimeParseError(raw)
}

function applyConstructionDayHeuristic(hour: number, part: 'start' | 'end'): number {
  if (hour >= 1 && hour <= 11 && part === 'end') return hour + 12
  return hour
}

function toMinutes(t: ParsedClockTime): number {
  return t.hour * 60 + t.minute
}

/**
 * `{ regularHours, overtimeHours, breakMinutes }` for one shift.
 *
 * `overtimeHours` is always `0` — see the module doc comment. There is no
 * parameter anywhere on this function that can change that; if ODS ever
 * gets an overtime policy, computing it belongs in a new, explicit function
 * that a caller has to opt into, not a silent branch in here.
 */
export function computeHours({ start, end, breakMinutes = DEFAULT_BREAK_MINUTES }: ComputeHoursInput): ComputedHours {
  const startTime = parseTimeOfDay(start, 'start')
  const endTime = parseTimeOfDay(end, 'end')
  const startMinutes = toMinutes(startTime)
  const endMinutes = toMinutes(endTime)

  if (endMinutes <= startMinutes) throw new InvalidTimeRangeError(start, end)

  const netMinutes = endMinutes - startMinutes - breakMinutes
  if (netMinutes <= 0) throw new InvalidTimeRangeError(start, end)

  const regularHours = Math.round((netMinutes / 60) * 100) / 100

  return { regularHours, overtimeHours: 0, breakMinutes }
}

// ---------------------------------------------------------------------------
// Draft assembly
// ---------------------------------------------------------------------------

export interface CrewDayShift {
  start: string
  end: string
  breakMinutes?: number
}

/** A per-worker override, e.g. "Cyril left at 2" -> `{ name: 'Cyril', end: '2' }`. */
export interface CrewDayException {
  /** Must match one of the entries in `CrewDayInput.names`, case-insensitively. */
  name: string
  start?: string
  end?: string
  breakMinutes?: number
}

export interface CrewDayInput {
  projectId: string
  /** ISO date, `YYYY-MM-DD`. */
  date: string
  /** Informal names as reported, e.g. `['me', 'Cyril', 'Dwight']`. */
  names: string[]
  /** The default shift applied to everyone unless an exception overrides it. */
  shift: CrewDayShift
  exceptions?: CrewDayException[]
  roster: RosterWorker[]
  /** Passed through to {@link resolveWorkers} to resolve "me". */
  callerId?: string
}

export interface CrewDayDraftRow {
  workerId: string
  workerName: string
  projectId: string
  date: string
  /** Normalized 24-hour `HH:MM`. */
  start: string
  /** Normalized 24-hour `HH:MM`. */
  end: string
  regularHours: number
  overtimeHours: 0
  breakMinutes: number
}

export type CrewDayIssue =
  | { kind: 'worker_ambiguous'; name: string; candidates: RosterWorker[] }
  | { kind: 'worker_unknown'; name: string; candidates: RosterWorker[] }
  | { kind: 'invalid_time'; name: string; start: string; end: string; message: string }

/**
 * The draft is a discriminated union, not `{ drafts, unresolved? }`, on
 * purpose: an optional field is a field a caller can forget to check. With
 * `status: 'needs_review'` there is no `drafts` array to accidentally read —
 * TypeScript won't let you reach it without first narrowing on `status`.
 */
export type CrewDayDraftResult =
  | { status: 'ready'; drafts: CrewDayDraftRow[] }
  | { status: 'needs_review'; issues: CrewDayIssue[] }

function findException(exceptions: CrewDayException[] | undefined, name: string): CrewDayException | undefined {
  if (!exceptions) return undefined
  const target = normalizeNamePart(name)
  return exceptions.find((ex) => normalizeNamePart(ex.name) === target)
}

function formatClockTime(t: ParsedClockTime): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`
}

/**
 * Assemble one draft row per resolved worker, applying per-worker exceptions
 * ("Cyril left at 2") on top of the crew's default shift.
 *
 * Every worker that fails to resolve, or whose exception/shift produces an
 * invalid time range, is reported as an issue instead of silently dropped
 * or silently defaulted — and as soon as there is one issue, `status` is
 * `'needs_review'` and there is no usable `drafts` array at all. The caller
 * must resolve every name and every time before this can be staged.
 */
export function buildCrewDayDraft(input: CrewDayInput): CrewDayDraftResult {
  const resolutions = resolveWorkers(input.names, input.roster, { callerId: input.callerId })

  const issues: CrewDayIssue[] = []
  const drafts: CrewDayDraftRow[] = []

  for (const resolution of resolutions) {
    if (resolution.classification === 'ambiguous') {
      issues.push({ kind: 'worker_ambiguous', name: resolution.name, candidates: resolution.candidates })
      continue
    }
    if (resolution.classification === 'unknown') {
      issues.push({ kind: 'worker_unknown', name: resolution.name, candidates: resolution.candidates })
      continue
    }

    const worker = resolution.worker
    const exception = findException(input.exceptions, resolution.name)
    const start = exception?.start ?? input.shift.start
    const end = exception?.end ?? input.shift.end
    const breakMinutes = exception?.breakMinutes ?? input.shift.breakMinutes ?? DEFAULT_BREAK_MINUTES

    try {
      const hours = computeHours({ start, end, breakMinutes })
      const startTime = parseTimeOfDay(start, 'start')
      const endTime = parseTimeOfDay(end, 'end')
      drafts.push({
        workerId: worker.id,
        workerName: fullName(worker),
        projectId: input.projectId,
        date: input.date,
        start: formatClockTime(startTime),
        end: formatClockTime(endTime),
        regularHours: hours.regularHours,
        overtimeHours: hours.overtimeHours,
        breakMinutes: hours.breakMinutes,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not compute hours for this worker.'
      issues.push({ kind: 'invalid_time', name: resolution.name, start, end, message })
    }
  }

  if (issues.length > 0) return { status: 'needs_review', issues }
  return { status: 'ready', drafts }
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/**
 * The slice of an already-recorded TropiTrack time entry this module needs
 * to detect a collision. The caller fetches these for the relevant
 * project + date; this function does no I/O of its own.
 */
export interface ExistingTimeEntry {
  workerId: string
  projectId: string
  date: string
}

function entryKey(e: { workerId: string; projectId: string; date: string }): string {
  return `${e.workerId} ${e.projectId} ${e.date}`
}

/**
 * Which draft rows collide with an already-recorded entry for the same
 * (worker, project, date). Omar re-reporting the same day over WhatsApp —
 * easy after a dropped connection — must never silently double the payroll,
 * so the caller is expected to refuse (or ask) rather than write these.
 */
export function findDuplicates(drafts: CrewDayDraftRow[], existingEntries: ExistingTimeEntry[]): CrewDayDraftRow[] {
  const existingKeys = new Set(existingEntries.map(entryKey))
  return drafts.filter((d) => existingKeys.has(entryKey(d)))
}
