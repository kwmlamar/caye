/**
 * How one business wants its domain interpreted — held in the workspace, not
 * in this file.
 *
 * WHY THIS EXISTS
 *
 * The construction work shipped so far encodes real business judgments as
 * constants: a 60-minute break, an 07:00-16:00 day, overtime always zero, an
 * approved estimate being a `decision` rather than an `awareness`. Every one of
 * those was measured or reasoned carefully — and every one of them is still a
 * guess about how a business we do not run wants to work.
 *
 * A guess in a constant needs a deploy to correct. A guess in the workspace can
 * be corrected by the owner saying so. This module makes them the second kind.
 *
 * THE PROPERTY THAT MATTERS MOST
 *
 * Every resolved value carries where it came from. Caye can then say "I logged
 * an hour lunch because that is what every past entry uses — tell me if that is
 * wrong" instead of silently applying a default nobody agreed to. A default the
 * owner never sees is indistinguishable from a decision they never got to make,
 * and that is how a system stops matching the business it serves.
 *
 * Storage is `domain_source_connections.config.policy`: already per-workspace,
 * already per-source-system, already non-secret, already constrained against
 * holding credentials. No migration, and nothing ODS-specific in the kernel.
 */

export type PolicySource = 'workspace' | 'default'

export interface PolicyValue<T> {
  value: T
  /** 'default' means nobody has told us otherwise — say so before relying on it. */
  source: PolicySource
}

function held<T>(raw: unknown, fallback: T, guard: (v: unknown) => v is T): PolicyValue<T> {
  return guard(raw) ? { value: raw, source: 'workspace' } : { value: fallback, source: 'default' }
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'
const isTime = (v: unknown): v is string => {
  if (typeof v !== 'string') return false
  const match = /^(\d{1,2}):(\d{2})$/.exec(v)
  if (!match) return false
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59
}

/**
 * Shipped defaults, and why each one is what it is.
 *
 * These are measurements of ODS's own history, not opinions — which is what
 * makes them decent defaults and still only defaults.
 */
export const CREW_DAY_DEFAULTS = {
  /** Every one of 3,883 existing entries uses a 60-minute break. */
  breakMinutes: 60,
  /** The dominant shift in the same data: 07:00-16:00 nets an 8-hour day. */
  standardStart: '07:00',
  standardEnd: '16:00',
  /**
   * No overtime policy is recorded anywhere in the business, and overtime
   * appears on 36 of 3,883 entries. Computing one would silently change what
   * somebody is paid, so it stays off until a real policy is stated.
   */
  overtimeEnabled: false,
  /**
   * Whether the person reporting a day is also on it. Wallace, Omar and Jay are
   * profiles with no worker row — they supervise rather than being paid hourly
   * — so the safe default is that "me" is the reporter, not a timesheet line.
   */
  reporterLogsOwnTime: false,
  /**
   * Refuse a day that would duplicate existing entries. A crew day written
   * twice doubles somebody's pay, so the default is to stop and let a human
   * decide rather than to merge or overwrite.
   */
  refuseDuplicates: true,
} as const

/**
 * A type alias rather than an interface on purpose: only aliases get an
 * implicit index signature, which is what lets a resolved policy be handed
 * straight to {@link unconfirmed} without a cast that would hide a real shape
 * mismatch.
 */
export type CrewDayPolicy = {
  breakMinutes: PolicyValue<number>
  standardStart: PolicyValue<string>
  standardEnd: PolicyValue<string>
  overtimeEnabled: PolicyValue<boolean>
  reporterLogsOwnTime: PolicyValue<boolean>
  refuseDuplicates: PolicyValue<boolean>
}

function section(config: Record<string, unknown> | null | undefined, name: string): Record<string, unknown> {
  const policy = (config ?? {})['policy']
  if (!policy || typeof policy !== 'object') return {}
  const found = (policy as Record<string, unknown>)[name]
  return found && typeof found === 'object' ? (found as Record<string, unknown>) : {}
}

export function resolveCrewDayPolicy(config: Record<string, unknown> | null | undefined): CrewDayPolicy {
  const c = section(config, 'crew_day')
  return {
    breakMinutes: held(c.break_minutes, CREW_DAY_DEFAULTS.breakMinutes, isNumber),
    standardStart: held(c.standard_start, CREW_DAY_DEFAULTS.standardStart, isTime),
    standardEnd: held(c.standard_end, CREW_DAY_DEFAULTS.standardEnd, isTime),
    overtimeEnabled: held(c.overtime_enabled, CREW_DAY_DEFAULTS.overtimeEnabled, isBoolean),
    reporterLogsOwnTime: held(c.reporter_logs_own_time, CREW_DAY_DEFAULTS.reporterLogsOwnTime, isBoolean),
    refuseDuplicates: held(c.refuse_duplicates, CREW_DAY_DEFAULTS.refuseDuplicates, isBoolean),
  }
}

/**
 * Which of a policy's values are still unconfirmed guesses.
 *
 * Handed to the model so a confirmation summary can name them. "8 hours each,
 * hour lunch — I'm assuming the lunch, tell me if it's different" is a sentence
 * that lets a business correct a system without anyone filing a ticket.
 */
export function unconfirmed(policy: Record<string, { source: PolicySource }>): string[] {
  return Object.entries(policy)
    .filter(([, v]) => v.source === 'default')
    .map(([key]) => key)
}

/**
 * The one thing worth asking about right now — or nothing.
 *
 * "Ask when you don't know" is only useful if it is disciplined. Asking about
 * all six assumptions on every crew day would be an interrogation, and someone
 * standing on a roof would stop answering by the third one. Two rules keep it
 * bearable:
 *
 *   - Ask about an assumption only when it actually shaped THIS result. A break
 *     length nobody's day depended on is not worth a question.
 *   - Ask about at most one thing at a time, most consequential first, so a
 *     reply is a sentence rather than a form.
 *
 * Returned as data rather than left to the model's judgement, for the same
 * reason ambiguous names are: whether to ask is a correctness decision, and a
 * prompt that usually remembers to ask is a prompt that sometimes does not.
 */
export interface PolicyQuestion {
  /** The `set_construction_policy` field a reply should settle. */
  key: string
  question: string
}

export interface CrewDayContext {
  /** The reporter named themselves among the crew. */
  reporterNamed: boolean
  /** A break was stated in the message, so the default did not decide it. */
  breakStated: boolean
  /** The longest net shift in the day, in hours. */
  longestShiftHours: number
}

export function nextCrewDayQuestion(
  policy: CrewDayPolicy,
  context: CrewDayContext
): PolicyQuestion | null {
  // Who is on the timesheet decides who gets paid, so it outranks the rest.
  if (context.reporterNamed && policy.reporterLogsOwnTime.source === 'default') {
    return {
      key: 'reporter_logs_own_time',
      question:
        'You said "me" — should I put your own hours on the timesheet too, or are you just reporting the crew? ' +
        "I've left you off for now.",
    }
  }

  // Every hour figure in the day rests on this one.
  if (!context.breakStated && policy.breakMinutes.source === 'default') {
    return {
      key: 'break_minutes',
      question: `I took an hour off for lunch, which is what every past entry uses. Is that right for this crew?`,
    }
  }

  // Only bites on a long day. On a normal one it would be noise.
  if (context.longestShiftHours > 8 && policy.overtimeEnabled.source === 'default') {
    return {
      key: 'overtime_enabled',
      question:
        `That's over 8 hours. I've logged it all as regular time because there's no overtime rule written down — ` +
        'tell me the rule if there is one.',
    }
  }

  return null
}

export interface AttentionOverride {
  priority?: string
  nextAction?: string | null
}

/**
 * Per-workspace overrides for how loudly a domain change is raised.
 *
 * The shipped table is a considered opinion about a construction business in
 * general. This is where one business says "an approved estimate is routine for
 * us, we already have a contract flow" — or the reverse — without a deploy and
 * without an engineer deciding on their behalf.
 */
export function resolveAttentionOverride(
  config: Record<string, unknown> | null | undefined,
  ruleKey: string
): AttentionOverride | null {
  const overrides = section(config, 'attention')
  const found = overrides[ruleKey]
  if (!found || typeof found !== 'object') return null

  const raw = found as Record<string, unknown>
  const override: AttentionOverride = {}
  if (typeof raw.priority === 'string') override.priority = raw.priority
  if (typeof raw.next_action === 'string') override.nextAction = raw.next_action
  if (raw.next_action === null) override.nextAction = null
  return Object.keys(override).length ? override : null
}

/**
 * Whether a workspace has muted a change entirely.
 *
 * Separate from priority because "do not tell me about receipts at all" is a
 * different instruction from "tell me quietly", and conflating them means the
 * only way to stop noise is to stop recording it.
 */
export function isMuted(config: Record<string, unknown> | null | undefined, ruleKey: string): boolean {
  const muted = section(config, 'attention')['muted']
  return Array.isArray(muted) && muted.includes(ruleKey)
}
