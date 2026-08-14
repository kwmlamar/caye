import 'server-only'
import { createServiceClient } from './supabase-server'

/**
 * pending-operations.ts
 *
 * Enqueue / claim / settle for `caye_pending_operations` — the durable outbox
 * that lets Caye finish a job whose external half is temporarily unavailable.
 *
 * The contract callers rely on:
 *   enqueueOperation() never throws.
 *
 * It is called from recovery paths, and a recovery path that can itself fail
 * loudly is not a recovery path. A failure to enqueue is logged and reported
 * in the return value; the caller decides whether the underlying write still
 * counts (for calendar sync it does — the booking is already committed).
 */

export type OperationKind = 'zoho_calendar_upsert' | 'zoho_calendar_delete' | 'outreach_sourcing'

export interface EnqueueArgs {
  workspaceId: string
  operation: OperationKind
  payload: Record<string, unknown>
  /**
   * Stable per logical intent. Two enqueues with the same key are the same
   * promise, not two promises — the unique index makes the second a no-op.
   */
  idempotencyKey: string
  requestId?: string | null
  lastError?: string | null
  delayMs?: number
}

export interface EnqueueResult {
  queued: boolean
  /** True when a row for this idempotency key already existed. */
  alreadyQueued: boolean
  reason?: string
}

/** Base for exponential backoff: 30s, 2m, 8m, 32m, ~2h, ~8.5h across 6 tries. */
const BACKOFF_BASE_MS = 30_000
const BACKOFF_FACTOR = 4

export function backoffDelayMs(attempts: number): number {
  return BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, Math.max(0, attempts))
}

export async function enqueueOperation(args: EnqueueArgs): Promise<EnqueueResult> {
  try {
    const supabase = createServiceClient()
    const { error } = await supabase.from('caye_pending_operations').insert({
      workspace_id: args.workspaceId,
      operation: args.operation,
      payload: args.payload,
      idempotency_key: args.idempotencyKey,
      request_id: args.requestId ?? null,
      last_error: args.lastError ?? null,
      next_attempt_at: new Date(Date.now() + (args.delayMs ?? backoffDelayMs(0))).toISOString(),
    })

    if (error) {
      // 23505: this intent is already queued. That is the system working —
      // the promise exists, one copy of it, which is the entire point.
      if (error.code === '23505') return { queued: true, alreadyQueued: true }
      console.error(`[pending-operations] enqueue ${args.operation} failed:`, error.message)
      return { queued: false, alreadyQueued: false, reason: error.message }
    }
    return { queued: true, alreadyQueued: false }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[pending-operations] enqueue ${args.operation} threw:`, msg)
    return { queued: false, alreadyQueued: false, reason: msg }
  }
}

export interface PendingOperationRow {
  id: string
  workspace_id: string
  operation: OperationKind
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
  idempotency_key: string
  request_id: string | null
  claim_token: string
}

/** Rows that are due now, oldest first. */
export async function claimDueOperations(limit = 25): Promise<PendingOperationRow[]> {
  const supabase = createServiceClient()
  await supabase.from('caye_pending_operations').update({ status: 'pending', claim_token: null, claimed_at: null })
    .eq('status', 'processing').lt('claimed_at', new Date(Date.now() - 10 * 60 * 1000).toISOString())
  const { data, error } = await supabase
    .from('caye_pending_operations')
    .select('id, workspace_id, operation, payload, attempts, max_attempts, idempotency_key, request_id')
    .eq('status', 'pending')
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(limit)

  if (error) {
    console.error('[pending-operations] claim failed:', error.message)
    return []
  }
  const claimed: PendingOperationRow[] = []
  for (const candidate of data ?? []) {
    const claimToken = crypto.randomUUID()
    const { data: row } = await supabase.from('caye_pending_operations')
      .update({ status: 'processing', claim_token: claimToken, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', candidate.id).eq('status', 'pending')
      .select('id, workspace_id, operation, payload, attempts, max_attempts, idempotency_key, request_id').maybeSingle()
    if (row) claimed.push({ ...(row as Omit<PendingOperationRow, 'claim_token'>), claim_token: claimToken })
  }
  return claimed
}

export async function markSynced(row: Pick<PendingOperationRow, 'id' | 'claim_token'>): Promise<void> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()
  await supabase
    .from('caye_pending_operations')
    .update({ status: 'synced', synced_at: now, updated_at: now, last_error: null, claim_token: null, claimed_at: null })
    .eq('id', row.id).eq('status', 'processing').eq('claim_token', row.claim_token)
}

/**
 * Record a failed attempt. Reschedules with backoff until max_attempts, then
 * dead-letters.
 *
 * Dead-lettering is an alerting event, never a data-loss event: the booking,
 * note, or record the operation mirrors is already committed in Supabase.
 * All that is lost is the mirror, and `bookings.calendar_sync_status` still
 * says so out loud.
 */
export async function markAttemptFailed(
  row: PendingOperationRow,
  error: string,
  opts: { retryable: boolean } = { retryable: true }
): Promise<'retrying' | 'dead_letter'> {
  const supabase = createServiceClient()
  const attempts = row.attempts + 1
  const exhausted = !opts.retryable || attempts >= row.max_attempts
  const now = new Date().toISOString()

  await supabase
    .from('caye_pending_operations')
    .update({
      attempts,
      last_error: error.slice(0, 500),
      status: exhausted ? 'dead_letter' : 'pending',
      next_attempt_at: exhausted
        ? now
        : new Date(Date.now() + backoffDelayMs(attempts)).toISOString(),
      updated_at: now,
      claim_token: null,
      claimed_at: null,
    })
    .eq('id', row.id).eq('claim_token', row.claim_token)

  return exhausted ? 'dead_letter' : 'retrying'
}

/**
 * Retire queued work for a record whose intent no longer applies — e.g. a
 * booking cancelled while its calendar upsert was still waiting. Cancelling
 * beats letting the worker recreate an event for a booking that is gone.
 */
export async function cancelOperationsForKey(idempotencyKeyPrefix: string): Promise<void> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()
  await supabase
    .from('caye_pending_operations')
    .update({ status: 'cancelled', updated_at: now })
    .eq('status', 'pending')
    .like('idempotency_key', `${idempotencyKeyPrefix}%`)
}
