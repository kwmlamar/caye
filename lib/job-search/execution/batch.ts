/**
 * Bounded autonomous submission batches.
 *
 * The problem this solves: confirming every individual application turns the
 * founder into a full-time approval button, but letting an agent submit
 * unbounded applications on a standing instruction is not something anyone
 * should ship. The middle ground is an explicit, bounded, EXPIRING grant:
 * "apply to up to 5 qualified Greenhouse jobs scoring 70+, in the next two
 * hours." Inside that envelope the worker proceeds without asking; outside
 * it, it stops.
 *
 * The envelope is enforced in the database, not here. `consume_job_search_
 * batch_slot` increments and bounds-checks in a single statement, so N
 * concurrent workers cannot collectively exceed max_applications - the same
 * reason the daily cap is an RPC rather than a read-then-count.
 *
 * WHAT ALWAYS BREAKS OUT OF THE ENVELOPE, no matter what was authorized:
 *   - an unresolved consequential question (never guess to stay in budget)
 *   - a job outside the authorized policy (provider, score, family)
 *   - an employer or destination that is not allowlisted
 *   - a CAPTCHA, login wall, or anti-bot challenge
 *   - a submission that comes back UNCERTAIN
 * The first four skip the application and continue. The fifth stops the whole
 * batch: uncertainty means we do not know what just happened at an employer,
 * and continuing to submit while that is true is how one ambiguous result
 * becomes five.
 */
import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { getJobSearchSettings } from '../settings'
import { logJobSearchEvent } from '../events'
import { getExecutionRolloutSettings } from './rollout'
import { executeApplication, type ExecuteApplicationResult } from './executor'
import type { ExecutionProvider } from './types'

/**
 * Maximum browser workers running at once.
 *
 * Deliberately small. Each worker is a full headless Chromium against a real
 * employer's form; the constraint is politeness and provider rate-tolerance,
 * not our own throughput. Three is the ceiling until real evidence says a
 * higher number is safe - and "we want 150/day" is not that evidence. 150/day
 * at 3 concurrent workers is roughly one application every ten minutes of
 * wall-clock, which is comfortably achievable without bursting.
 */
export const MAX_BATCH_CONCURRENCY = 3
export const DEFAULT_BATCH_CONCURRENCY = 1

/** Minimum spacing between the START of consecutive submissions, per worker. Non-abusive pacing, not evasion. */
export const MIN_SUBMISSION_SPACING_MS = 20_000

export type BatchAuthorization = {
  id: string
  provider: ExecutionProvider
  maxApplications: number
  minScore: number
  allowedJobFamilies: string[]
  consumedCount: number
  expiresAt: string
  revokedAt: string | null
}

export type GrantBatchAuthorizationInput = {
  provider: ExecutionProvider
  maxApplications: number
  minScore?: number
  allowedJobFamilies?: string[]
  windowMinutes?: number
  actor: string
}

const DEFAULT_WINDOW_MINUTES = 120
const MAX_WINDOW_MINUTES = 24 * 60

export async function grantBatchAuthorization(input: GrantBatchAuthorizationInput): Promise<{ ok: true; authorization: BatchAuthorization } | { ok: false; error: string }> {
  if (!Number.isInteger(input.maxApplications) || input.maxApplications < 1) return { ok: false, error: 'A batch authorization must permit at least one application.' }
  const windowMinutes = Math.min(input.windowMinutes ?? DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES)

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('job_search_batch_authorizations')
    .insert({
      created_by: input.actor,
      provider: input.provider,
      max_applications: input.maxApplications,
      min_score: input.minScore ?? 0,
      allowed_job_families: input.allowedJobFamilies ?? [],
      expires_at: new Date(Date.now() + windowMinutes * 60 * 1000).toISOString(),
    })
    .select('id, provider, max_applications, min_score, allowed_job_families, consumed_count, expires_at, revoked_at')

  const row = (data as Record<string, unknown>[] | null)?.[0]
  if (error || !row) return { ok: false, error: error?.message ?? 'Could not create the batch authorization.' }

  await logJobSearchEvent({
    eventType: 'settings_changed',
    entityType: 'settings',
    payload: { batch_authorization_granted: true, provider: input.provider, max_applications: input.maxApplications, min_score: input.minScore ?? 0, expires_at: row.expires_at },
    createdBy: input.actor,
  })

  return { ok: true, authorization: mapAuthorization(row) }
}

function mapAuthorization(row: Record<string, unknown>): BatchAuthorization {
  return {
    id: row.id as string,
    provider: row.provider as ExecutionProvider,
    maxApplications: row.max_applications as number,
    minScore: row.min_score as number,
    allowedJobFamilies: (row.allowed_job_families as string[]) ?? [],
    consumedCount: (row.consumed_count as number) ?? 0,
    expiresAt: row.expires_at as string,
    revokedAt: (row.revoked_at as string) ?? null,
  }
}

export async function getBatchAuthorization(id: string): Promise<BatchAuthorization | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('job_search_batch_authorizations')
    .select('id, provider, max_applications, min_score, allowed_job_families, consumed_count, expires_at, revoked_at')
    .eq('id', id)
    .maybeSingle()
  return data ? mapAuthorization(data as Record<string, unknown>) : null
}

export async function revokeBatchAuthorization(id: string, actor: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { error } = await supabase.from('job_search_batch_authorizations').update({ revoked_at: new Date().toISOString() }).eq('id', id).is('revoked_at', null)
  if (!error) await logJobSearchEvent({ eventType: 'settings_changed', entityType: 'settings', payload: { batch_authorization_revoked: id }, createdBy: actor })
  return !error
}

/** Atomically claims one slot from the authorization. False means the envelope is exhausted, expired, revoked, or scoped to another provider. */
async function consumeBatchSlot(authorizationId: string, provider: ExecutionProvider): Promise<boolean> {
  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('consume_job_search_batch_slot', { p_authorization_id: authorizationId, p_provider: provider })
  return !error && data === true
}

export type BatchCandidate = {
  applicationId: string
  candidateId: string
  company: string
  title: string
  fitScore: number | null
  provider: ExecutionProvider
}

export type BatchOutcome = {
  authorizationId: string
  attempted: number
  submitted: number
  uncertain: number
  needsHuman: number
  failed: number
  skipped: { applicationId: string; reason: string }[]
  stoppedEarly: string | null
  results: { applicationId: string; outcome: string; reason?: string }[]
}

/** Derives the provider from the destination host, never from a stored label. */
function providerForUrl(applyUrl: string): ExecutionProvider {
  try {
    const host = new URL(applyUrl).hostname.toLowerCase()
    if (host.endsWith('greenhouse.io')) return 'greenhouse'
  } catch {
    return 'generic'
  }
  return 'generic'
}

/** PREPARED applications eligible for this authorization, best-scoring first. */
export async function selectBatchCandidates(authorization: BatchAuthorization, limit: number): Promise<BatchCandidate[]> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('job_search_applications')
    .select('id, candidate_id, status')
    .eq('status', 'PREPARED')
    .limit(Math.max(limit * 4, limit))

  const applications = (data as { id: string; candidate_id: string }[] | null) ?? []
  if (applications.length === 0) return []

  const candidates: BatchCandidate[] = []
  for (const application of applications) {
    const { data: candidate } = await supabase
      .from('job_search_candidates')
      .select('id, company, title, fit_score, status, apply_url')
      .eq('id', application.candidate_id)
      .maybeSingle()
    if (!candidate) continue
    if (candidate.status === 'REJECTED') continue

    const provider = providerForUrl(candidate.apply_url as string)
    if (provider !== authorization.provider) continue

    const fitScore = (candidate.fit_score as number | null) ?? null
    // Quality is never traded for throughput: an application below the
    // authorized score is skipped even if that leaves the batch unfilled.
    if (authorization.minScore > 0 && (fitScore ?? 0) < authorization.minScore) continue

    if (authorization.allowedJobFamilies.length > 0) {
      const title = String(candidate.title ?? '').toLowerCase()
      if (!authorization.allowedJobFamilies.some((family) => title.includes(family.toLowerCase()))) continue
    }

    candidates.push({
      applicationId: application.id,
      candidateId: candidate.id as string,
      company: candidate.company as string,
      title: candidate.title as string,
      fitScore,
      provider,
    })
  }

  candidates.sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0))
  return candidates.slice(0, limit)
}

/**
 * Runs one founder-authorized batch.
 *
 * Structure notes:
 *  - Concurrency is bounded by a fixed worker pool pulling from a shared
 *    cursor, not by fanning out every candidate at once.
 *  - Every per-application failure is caught. One bad application produces one
 *    bad result, never a dead batch.
 *  - The kill switches are re-read before EVERY application, not once at the
 *    top: a founder who pauses mid-batch expects the next application not to
 *    go out.
 */
export async function runAuthorizedBatch(authorizationId: string, options: { concurrency?: number; spacingMs?: number } = {}): Promise<BatchOutcome> {
  const outcome: BatchOutcome = {
    authorizationId,
    attempted: 0,
    submitted: 0,
    uncertain: 0,
    needsHuman: 0,
    failed: 0,
    skipped: [],
    stoppedEarly: null,
    results: [],
  }

  const authorization = await getBatchAuthorization(authorizationId)
  if (!authorization) {
    outcome.stoppedEarly = 'That batch authorization does not exist.'
    return outcome
  }
  if (authorization.revokedAt) {
    outcome.stoppedEarly = 'That batch authorization was revoked.'
    return outcome
  }
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    outcome.stoppedEarly = 'That batch authorization has expired; a new one is required.'
    return outcome
  }

  const remaining = authorization.maxApplications - authorization.consumedCount
  if (remaining <= 0) {
    outcome.stoppedEarly = 'That batch authorization is already fully consumed.'
    return outcome
  }

  // Bound to a non-nullable local so the worker closure below keeps the
  // narrowing TypeScript established by the guards above.
  const grant = authorization
  const candidates = await selectBatchCandidates(grant, remaining)
  if (candidates.length === 0) {
    outcome.stoppedEarly = 'No PREPARED applications currently match this authorization.'
    return outcome
  }

  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_BATCH_CONCURRENCY, MAX_BATCH_CONCURRENCY))
  let cursor = 0
  let halted: string | null = null

  async function worker(): Promise<void> {
    let lastStart = 0
    for (;;) {
      if (halted) return
      const index = cursor++
      if (index >= candidates.length) return
      const candidate = candidates[index]

      // Kill switches, re-read per application.
      const [settings, rollout] = await Promise.all([getJobSearchSettings(), getExecutionRolloutSettings()])
      if (rollout.emergencyPaused) { halted = 'Execution was emergency-paused; the batch stopped.'; return }
      if (settings.paused) { halted = 'Job search was paused; the batch stopped.'; return }
      if (rollout.dryRun || !rollout.automationEnabled) { halted = 'Live automation was switched off; the batch stopped.'; return }

      // Non-abusive pacing between consecutive submissions from one worker.
      const spacing = options.spacingMs ?? MIN_SUBMISSION_SPACING_MS
      const sinceLast = Date.now() - lastStart
      if (lastStart > 0 && sinceLast < spacing) {
        await new Promise((resolve) => setTimeout(resolve, spacing - sinceLast))
      }
      lastStart = Date.now()

      // Claim budget BEFORE acting. A slot consumed by an application that
      // then fails is deliberate: the envelope bounds attempts at an employer,
      // not successes, and refunding it would let a flapping application
      // consume the batch indefinitely.
      const claimed = await consumeBatchSlot(grant.id, grant.provider)
      if (!claimed) { halted = 'The batch authorization was exhausted, revoked, or expired mid-run.'; return }

      outcome.attempted += 1
      let result: ExecuteApplicationResult
      try {
        result = await executeApplication(candidate.applicationId, { batchAuthorizationId: grant.id })
      } catch (error) {
        // One bad application must never take down the batch.
        outcome.failed += 1
        outcome.results.push({ applicationId: candidate.applicationId, outcome: 'failed', reason: error instanceof Error ? error.message : String(error) })
        continue
      }

      switch (result.outcome) {
        case 'submitted':
          outcome.submitted += 1
          outcome.results.push({ applicationId: candidate.applicationId, outcome: 'submitted', reason: result.confirmationId })
          break
        case 'submission_uncertain':
          outcome.uncertain += 1
          outcome.results.push({ applicationId: candidate.applicationId, outcome: 'submission_uncertain', reason: result.reason })
          // Stop the whole batch. We do not know what just happened at an
          // employer, and continuing while that is true multiplies the
          // problem instead of containing it.
          halted = 'A submission came back UNCERTAIN. The batch stopped so the result can be reconciled before anything else is sent.'
          return
        case 'needs_human':
          outcome.needsHuman += 1
          outcome.results.push({ applicationId: candidate.applicationId, outcome: 'needs_human', reason: result.reason })
          break
        case 'preflight_blocked':
          outcome.skipped.push({ applicationId: candidate.applicationId, reason: result.reason })
          outcome.results.push({ applicationId: candidate.applicationId, outcome: 'preflight_blocked', reason: result.reason })
          break
        case 'skipped_concurrent_claim':
          outcome.skipped.push({ applicationId: candidate.applicationId, reason: 'Another worker already held this application.' })
          outcome.results.push({ applicationId: candidate.applicationId, outcome: 'skipped_concurrent_claim' })
          break
        default:
          outcome.failed += 1
          outcome.results.push({ applicationId: candidate.applicationId, outcome: result.outcome, reason: 'reason' in result ? result.reason : undefined })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()))
  outcome.stoppedEarly = halted

  await logJobSearchEvent({
    eventType: 'settings_changed',
    entityType: 'settings',
    payload: {
      batch_run: authorizationId,
      attempted: outcome.attempted,
      submitted: outcome.submitted,
      uncertain: outcome.uncertain,
      needs_human: outcome.needsHuman,
      stopped_early: outcome.stoppedEarly,
    },
  })

  return outcome
}
