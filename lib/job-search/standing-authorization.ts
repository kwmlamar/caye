/**
 * Founder standing authorization for autonomous job applications.
 *
 * The founder manages POLICY, not individual clicks. Once a standing
 * authorization is active, an application that falls inside it is already
 * authorized — no per-application and no per-batch confirmation.
 *
 * Three properties this module exists to guarantee:
 *
 * 1. Authorization is durable server-side state, never a model assertion.
 *    Nothing here accepts "the founder said yes" as an argument. The only way
 *    to become authorized is a row written by a founder-scoped tool, and the
 *    only way to stay authorized is for that row to still say so at click time.
 *
 * 2. The policy bounds WHAT MAY HAPPEN WITHOUT ASKING. It never lowers a
 *    safety or quality threshold. Every check in
 *    execution/submission-gate.ts still runs, unchanged, on every application.
 *
 * 3. Pause and revoke win immediately. They are read fresh before every
 *    submission, not cached for a batch.
 *
 * Stored on job_search_execution_settings — the same singleton the submission
 * authority boundary already re-reads before every click — so there is exactly
 * one answer to "may Caye submit right now", and the emergency kill switch
 * still outranks all of it.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { logJobSearchEvent } from './events'
import { MAX_DAILY_SUBMISSION_CAP } from './execution/rollout'

export type StandingAuthorization = {
  enabled: boolean
  authorizedAt: string | null
  authorizedBy: string | null
  /** The founder instruction this grant was made from. Provenance, not config. */
  evidence: Record<string, unknown>
  revokedAt: string | null
  pausedAt: string | null
  pausedReason: string | null
  minFitScore: number
  maxApplicationsPerDay: number
  allowedJobFamilies: string[]
  allowedProviders: string[]
  excludedEmployers: string[]
  pauseOnSubmissionUncertain: boolean
  useVerifiedFactsOnly: boolean
}

/**
 * What an unreadable policy means: not authorized. Every failure mode here
 * resolves toward "ask", never toward "submit".
 */
const FAIL_CLOSED: StandingAuthorization = {
  enabled: false,
  authorizedAt: null,
  authorizedBy: null,
  evidence: {},
  revokedAt: null,
  pausedAt: null,
  pausedReason: 'standing authorization unreadable — failing closed',
  minFitScore: 100,
  maxApplicationsPerDay: 0,
  allowedJobFamilies: [],
  allowedProviders: [],
  excludedEmployers: [],
  pauseOnSubmissionUncertain: true,
  useVerifiedFactsOnly: true,
}

const COLUMNS = [
  'standing_authorization_enabled',
  'standing_authorized_at',
  'standing_authorized_by',
  'standing_authorization_evidence',
  'standing_revoked_at',
  'standing_paused_at',
  'standing_paused_reason',
  'standing_min_fit_score',
  'standing_max_applications_per_day',
  'standing_allowed_job_families',
  'standing_allowed_providers',
  'standing_excluded_employers',
  'standing_pause_on_submission_uncertain',
  'standing_use_verified_facts_only',
].join(', ')

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

export async function getStandingAuthorization(): Promise<StandingAuthorization> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('job_search_execution_settings')
    .select(COLUMNS)
    .eq('id', true)
    .maybeSingle()

  if (error || !data) return { ...FAIL_CLOSED }
  const row = data as unknown as Record<string, unknown>

  return {
    enabled: row.standing_authorization_enabled === true,
    authorizedAt: (row.standing_authorized_at as string) ?? null,
    authorizedBy: (row.standing_authorized_by as string) ?? null,
    evidence: (row.standing_authorization_evidence as Record<string, unknown>) ?? {},
    revokedAt: (row.standing_revoked_at as string) ?? null,
    pausedAt: (row.standing_paused_at as string) ?? null,
    pausedReason: (row.standing_paused_reason as string) ?? null,
    minFitScore: typeof row.standing_min_fit_score === 'number' ? row.standing_min_fit_score : FAIL_CLOSED.minFitScore,
    maxApplicationsPerDay: typeof row.standing_max_applications_per_day === 'number' ? row.standing_max_applications_per_day : 0,
    allowedJobFamilies: stringArray(row.standing_allowed_job_families),
    allowedProviders: stringArray(row.standing_allowed_providers),
    excludedEmployers: stringArray(row.standing_excluded_employers),
    pauseOnSubmissionUncertain: row.standing_pause_on_submission_uncertain !== false,
    useVerifiedFactsOnly: row.standing_use_verified_facts_only !== false,
  }
}

/**
 * Why this policy may not authorize a submission right now, or null if it may.
 *
 * Separate from the per-application decision: this answers "is there standing
 * authority at all", not "does this job qualify".
 */
export function standingAuthorizationDenial(policy: StandingAuthorization): string | null {
  if (!policy.enabled) return 'No standing job-search authorization is active.'
  if (policy.revokedAt) return 'The standing job-search authorization was revoked.'
  if (policy.pausedAt) return `Job applications are paused${policy.pausedReason ? `: ${policy.pausedReason}` : '.'}`
  if (policy.maxApplicationsPerDay <= 0) return 'The standing authorization permits zero applications per day.'
  if (!policy.useVerifiedFactsOnly) return 'Standing authorization requires verified-facts-only answering.'
  return null
}

export function isStandingAuthorizationActive(policy: StandingAuthorization): boolean {
  return standingAuthorizationDenial(policy) === null
}

async function update(patch: Record<string, unknown>, actor: string, payload: Record<string, unknown>): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from('job_search_execution_settings')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', true)
  if (error) throw new Error(`Could not update standing job-search authorization: ${error.message}`)
  await logJobSearchEvent({ eventType: 'settings_changed', entityType: 'settings', payload, createdBy: actor })
}

export type GrantStandingAuthorizationInput = {
  actor: string
  /** The founder's own words. Recorded as provenance for the grant. */
  instruction: string
  maxApplicationsPerDay?: number
  minFitScore?: number
  allowedJobFamilies?: string[]
  excludedEmployers?: string[]
}

/**
 * Grant standing authorization.
 *
 * This is also what replaces the old three-step activation ritual
 * ("enable live application automation" / "turn off dry-run mode" / authorize a
 * batch). One founder instruction flips the execution flags the authority
 * boundary already enforces, so there is no second Yes loop — and no new
 * bypass, because submission-gate.ts still reads exactly the same flags.
 */
export async function grantStandingAuthorization(input: GrantStandingAuthorizationInput): Promise<{ ok: true; policy: StandingAuthorization } | { ok: false; error: string }> {
  const cap = input.maxApplicationsPerDay ?? 150
  if (!Number.isInteger(cap) || cap < 1) return { ok: false, error: 'The daily application ceiling must be a positive whole number.' }
  if (cap > MAX_DAILY_SUBMISSION_CAP) {
    return { ok: false, error: `The daily application ceiling may not exceed ${MAX_DAILY_SUBMISSION_CAP}.` }
  }
  const minScore = input.minFitScore ?? 70
  if (!Number.isInteger(minScore) || minScore < 0 || minScore > 100) return { ok: false, error: 'The minimum fit score must be a whole number between 0 and 100.' }
  if (!input.instruction.trim()) return { ok: false, error: 'A standing authorization must record the founder instruction that granted it.' }

  const now = new Date().toISOString()
  await update({
    standing_authorization_enabled: true,
    standing_authorized_at: now,
    standing_authorized_by: input.actor,
    standing_authorization_evidence: { instruction: input.instruction.trim(), granted_at: now, actor: input.actor },
    standing_revoked_at: null,
    standing_paused_at: null,
    standing_paused_reason: null,
    standing_max_applications_per_day: cap,
    standing_min_fit_score: minScore,
    ...(input.allowedJobFamilies ? { standing_allowed_job_families: input.allowedJobFamilies } : {}),
    ...(input.excludedEmployers ? { standing_excluded_employers: input.excludedEmployers } : {}),
    // The founder's single instruction turns on the execution path the
    // authority boundary gates. Nothing here bypasses that boundary.
    automation_enabled: true,
    dry_run: false,
  }, input.actor, { standing_authorization_granted: true, max_applications_per_day: cap, min_fit_score: minScore })

  return { ok: true, policy: await getStandingAuthorization() }
}

/** "Pause job applications." Reversible, immediate, and it wins mid-batch. */
export async function pauseStandingAuthorization(reason: string, actor: string): Promise<void> {
  await update(
    { standing_paused_at: new Date().toISOString(), standing_paused_reason: reason },
    actor,
    { standing_authorization_paused: true, reason },
  )
}

/** "Resume job applications." Cannot resurrect a revoked authorization. */
export async function resumeStandingAuthorization(actor: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const policy = await getStandingAuthorization()
  if (!policy.enabled || policy.revokedAt) {
    return { ok: false, error: 'There is no standing job-search authorization to resume. Ask the founder to start applications again.' }
  }
  await update({ standing_paused_at: null, standing_paused_reason: null }, actor, { standing_authorization_resumed: true })
  return { ok: true }
}

/**
 * "Stop applying for jobs." Ends the authorization outright and puts the
 * execution flags back to their safe defaults, so restarting is a fresh,
 * deliberate grant rather than an un-pause.
 */
export async function revokeStandingAuthorization(actor: string, reason: string): Promise<void> {
  await update({
    standing_authorization_enabled: false,
    standing_revoked_at: new Date().toISOString(),
    standing_paused_at: null,
    standing_paused_reason: null,
    automation_enabled: false,
    dry_run: true,
  }, actor, { standing_authorization_revoked: true, reason })
}

export type StandingPolicyPatch = {
  minFitScore?: number
  maxApplicationsPerDay?: number
  allowedJobFamilies?: string[]
  excludedEmployers?: string[]
}

/**
 * Adjust the envelope without re-granting. Every change takes effect on the
 * next authority read, which happens before the next click — never after it.
 */
export async function updateStandingPolicy(patch: StandingPolicyPatch, actor: string): Promise<{ ok: true; policy: StandingAuthorization } | { ok: false; error: string }> {
  const update_: Record<string, unknown> = {}

  if (patch.minFitScore !== undefined) {
    if (!Number.isInteger(patch.minFitScore) || patch.minFitScore < 0 || patch.minFitScore > 100) {
      return { ok: false, error: 'The minimum fit score must be a whole number between 0 and 100.' }
    }
    update_.standing_min_fit_score = patch.minFitScore
  }
  if (patch.maxApplicationsPerDay !== undefined) {
    if (!Number.isInteger(patch.maxApplicationsPerDay) || patch.maxApplicationsPerDay < 0) {
      return { ok: false, error: 'The daily application ceiling must be a non-negative whole number.' }
    }
    if (patch.maxApplicationsPerDay > MAX_DAILY_SUBMISSION_CAP) {
      return { ok: false, error: `The daily application ceiling may not exceed ${MAX_DAILY_SUBMISSION_CAP}.` }
    }
    update_.standing_max_applications_per_day = patch.maxApplicationsPerDay
  }
  if (patch.allowedJobFamilies !== undefined) update_.standing_allowed_job_families = patch.allowedJobFamilies
  if (patch.excludedEmployers !== undefined) update_.standing_excluded_employers = patch.excludedEmployers

  if (Object.keys(update_).length === 0) return { ok: false, error: 'No policy change was specified.' }

  await update(update_, actor, { standing_policy_updated: update_ })
  return { ok: true, policy: await getStandingAuthorization() }
}
