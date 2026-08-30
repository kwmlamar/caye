import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ObjectiveEvent, ObjectiveRunResult } from './objective-run'

const RESUMABLE = ['running', 'budget_exhausted'] as const
const MIN_LEASE_MS = 90_000

function leaseExpiry(timeoutMs: number) {
  return new Date(Date.now() + Math.max(MIN_LEASE_MS, timeoutMs + 30_000)).toISOString()
}

export async function openOrResumeObjectiveRun(input: {
  supabase: SupabaseClient
  objectiveKey: string
  scopeKind: 'workspace' | 'founder'
  workspaceId: string | null
  actorKey: string
  maxTransitions: number
  timeoutMs: number
  metadata?: Record<string, unknown>
}) {
  const { supabase } = input
  const runnerToken = randomUUID()
  const now = new Date().toISOString()
  const leaseUntil = leaseExpiry(input.timeoutMs)

  let query = supabase
    .from('operator_objective_runs')
    .select('id,status,blocked_step,lease_token,lease_expires_at,metadata')
    .eq('objective_key', input.objectiveKey)
    .eq('scope_kind', input.scopeKind)
    .eq('actor_key', input.actorKey)
    .in('status', [...RESUMABLE])
    .order('updated_at', { ascending: false })
    .limit(1)

  query = input.workspaceId ? query.eq('workspace_id', input.workspaceId) : query.is('workspace_id', null)
  const existing = await query.maybeSingle()
  if (existing.error) throw new Error(`Could not find resumable objective run: ${existing.error.message}`)

  let runId = existing.data?.id as string | undefined
  let metadata = (existing.data?.metadata ?? input.metadata ?? {}) as Record<string, unknown>
  if (!runId) {
    metadata = input.metadata ?? {}
    const created = await supabase
      .from('operator_objective_runs')
      .insert({
        objective_key: input.objectiveKey,
        scope_kind: input.scopeKind,
        workspace_id: input.workspaceId,
        actor_key: input.actorKey,
        status: 'running',
        max_transitions: input.maxTransitions,
        timeout_ms: input.timeoutMs,
        metadata,
        lease_token: runnerToken,
        lease_expires_at: leaseUntil,
      })
      .select('id')
      .single()
    if (created.error || !created.data) {
      if (created.error?.code === '23505') throw new Error('Objective run is already claimed by another worker')
      throw new Error(`Could not create objective run: ${created.error?.message ?? 'unknown error'}`)
    }
    runId = created.data.id as string
  } else {
    const claimed = await supabase
      .from('operator_objective_runs')
      .update({
        status: 'running',
        blocked_step: null,
        lease_token: runnerToken,
        lease_expires_at: leaseUntil,
        updated_at: now,
      })
      .eq('id', runId)
      .or(`lease_token.is.null,lease_expires_at.lt.${now}`)
      .select('id')
      .maybeSingle()
    if (claimed.error) throw new Error(`Could not claim objective run: ${claimed.error.message}`)
    if (!claimed.data) throw new Error('Objective run is already claimed by another worker')
  }

  const progress = await supabase
    .from('operator_objective_events')
    .select('step_key,state')
    .eq('run_id', runId)
  if (progress.error) throw new Error(`Could not read objective progress: ${progress.error.message}`)

  const rows = progress.data ?? []
  return {
    runId,
    runnerToken,
    metadata,
    completedSteps: new Set(rows.filter((row) => row.state === 'verified').map((row) => row.step_key as string)),
    transitionsUsed: rows.filter((row) => row.state === 'running').length,
  }
}

async function refreshLease(supabase: SupabaseClient, runId: string, runnerToken: string, timeoutMs: number) {
  const now = new Date().toISOString()
  const touched = await supabase
    .from('operator_objective_runs')
    .update({ updated_at: now, lease_expires_at: leaseExpiry(timeoutMs) })
    .eq('id', runId)
    .eq('lease_token', runnerToken)
    .gt('lease_expires_at', now)
    .select('id')
    .maybeSingle()
  if (touched.error) throw new Error(`Could not refresh objective lease: ${touched.error.message}`)
  if (!touched.data) throw new Error('Objective execution lease was lost')
}

export async function persistObjectiveEvent(
  supabase: SupabaseClient,
  runId: string,
  runnerToken: string,
  timeoutMs: number,
  event: ObjectiveEvent
) {
  await refreshLease(supabase, runId, runnerToken, timeoutMs)

  const inserted = await supabase.from('operator_objective_events').insert({
    run_id: runId,
    step_key: event.step,
    state: event.state,
    attempt: event.attempt,
    evidence: event.evidence ?? null,
    error: event.error ?? null,
    occurred_at: event.at,
  })
  if (inserted.error) throw new Error(`Could not persist objective event: ${inserted.error.message}`)
}

export async function finalizeObjectiveRun(
  supabase: SupabaseClient,
  runId: string,
  runnerToken: string,
  result: ObjectiveRunResult,
  existingMetadata: Record<string, unknown> = {}
) {
  const terminal = result.status === 'completed' || result.status === 'blocked' || result.status === 'failed'
  const updated = await supabase
    .from('operator_objective_runs')
    .update({
      status: result.status,
      blocked_step: result.blockedStep ?? null,
      updated_at: new Date().toISOString(),
      completed_at: terminal ? new Date().toISOString() : null,
      metadata: {
        ...existingMetadata,
        completedSteps: result.completedSteps,
        transitionsUsed: result.transitionsUsed,
      },
      lease_token: null,
      lease_expires_at: null,
    })
    .eq('id', runId)
    .eq('lease_token', runnerToken)
    .select('id')
    .maybeSingle()
  if (updated.error) throw new Error(`Could not finalize objective run: ${updated.error.message}`)
  if (!updated.data) throw new Error('Objective execution lease was lost before finalization')
}
