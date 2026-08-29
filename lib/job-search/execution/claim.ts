/**
 * Job-search operator (CAY-194 / #194) — application execution claim/lease.
 *
 * Mirrors lib/artifacts/process.ts's claimForProcessing/releaseClaim
 * pattern exactly for the atomic acquisition mechanic: the claim itself IS
 * the conditional UPDATE ... WHERE status = 'PREPARED' ... RETURNING, not a
 * separate read-then-write, so two concurrent workers can never both win it
 * — Postgres's row-level locking on UPDATE serializes the two attempts.
 *
 * Deliberately DIFFERENT from that pattern in one important way: a stale
 * (expired) claim there resets back to a retryable state ('failed', safe
 * to reprocess) because re-running artifact understanding has no external
 * side effect. Submitting a job application does. A worker that crashed
 * mid-APPLYING might already have called the ATS submit endpoint before it
 * died — we cannot tell from a timeout alone whether it did. So a stale
 * claim here resolves to NEEDS_HUMAN, never back to PREPARED: "crashes
 * must not strand applications forever" is satisfied by making the
 * application visible in the human-review queue, not by guessing it's
 * safe to silently retry.
 */
import 'server-only'
import crypto from 'node:crypto'
import { createServiceClient } from '@/lib/supabase-server'
import { logJobSearchEvent } from '../events'

/** How long an APPLYING lease is honored before being treated as an abandoned/crashed worker. */
export const EXECUTION_LEASE_MS = 5 * 60 * 1000

export type ApplicationClaim = { applicationId: string; token: string; attemptNumber: number }

/**
 * Resets any APPLYING claim older than EXECUTION_LEASE_MS to NEEDS_HUMAN.
 * Never touches a live (in-window) lease, and never touches a row that
 * isn't currently APPLYING.
 */
export async function reapStaleExecutionClaims(): Promise<number> {
  const supabase = createServiceClient()
  const cutoff = new Date(Date.now() - EXECUTION_LEASE_MS).toISOString()

  const { data, error } = await supabase
    .from('job_search_applications')
    .update({
      status: 'NEEDS_HUMAN',
      needs_human_reason:
        'Execution claim expired without a recorded outcome — a previous attempt may have crashed during or after submission. A human must verify the actual ATS/email state before any retry; this was never auto-retried.',
      execution_claim_token: null,
      execution_claimed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'APPLYING')
    .lt('execution_claimed_at', cutoff)
    .select('id')

  const reaped = (data ?? []).length
  if (reaped > 0) {
    for (const row of data as { id: string }[]) {
      await logJobSearchEvent({
        eventType: 'application_needs_human',
        entityType: 'application',
        entityId: row.id,
        payload: { reason: 'stale_execution_claim_reaped' },
      })
    }
  }
  return error ? 0 : reaped
}

/**
 * Atomic compare-and-set claim. Only an application currently 'PREPARED'
 * can be claimed. Reaps stale claims first so a genuinely crashed worker's
 * row doesn't block forever, but a live claim is never disturbed.
 */
export async function claimApplicationForExecution(applicationId: string): Promise<ApplicationClaim | null> {
  await reapStaleExecutionClaims()

  const supabase = createServiceClient()
  const { data: current } = await supabase
    .from('job_search_applications')
    .select('execution_attempt_count')
    .eq('id', applicationId)
    .maybeSingle()
  if (!current) return null

  const token = crypto.randomUUID()
  const nextAttempt = (current.execution_attempt_count ?? 0) + 1

  const { data } = await supabase
    .from('job_search_applications')
    .update({
      status: 'APPLYING',
      execution_claim_token: token,
      execution_claimed_at: new Date().toISOString(),
      execution_attempt_count: nextAttempt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', applicationId)
    .eq('status', 'PREPARED')
    .select('id')

  const row = (data as { id: string }[] | null)?.[0]
  if (!row) return null

  await logJobSearchEvent({ eventType: 'application_submit_attempted', entityType: 'application', entityId: applicationId, payload: { attempt: nextAttempt } })
  return { applicationId, token, attemptNumber: nextAttempt }
}

/**
 * Only the current lease holder (matching claim_token) may release it. Sets
 * the application to its final status.
 *
 * Returns whether the release actually applied. This is not cosmetic: the
 * `.eq('execution_claim_token', claim.token)` guard means a worker whose
 * lease expired (and was reaped to NEEDS_HUMAN, clearing the token) silently
 * matches ZERO rows. Callers previously ignored that and went on to report
 * success — so a stale worker could believe it had written SUBMITTED while
 * the row said NEEDS_HUMAN, and the audit trail and the application status
 * would disagree with no signal anywhere. A caller that performed a real
 * external action MUST check this and escalate when it is false.
 */
export async function releaseExecutionClaim(
  claim: ApplicationClaim,
  finalStatus: 'SUBMITTED' | 'NEEDS_HUMAN' | 'SUBMISSION_UNCERTAIN' | 'FAILED' | 'PREPARED',
  patch: Record<string, unknown> = {},
): Promise<boolean> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('job_search_applications')
    .update({
      status: finalStatus,
      execution_claim_token: null,
      execution_claimed_at: null,
      updated_at: new Date().toISOString(),
      ...patch,
    })
    .eq('id', claim.applicationId)
    .eq('execution_claim_token', claim.token)
    .select('id')

  if (error) return false
  return (data ?? []).length > 0
}
