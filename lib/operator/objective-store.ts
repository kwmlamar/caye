import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ObjectiveEvent, ObjectiveRunResult } from './objective-run'

const RESUMABLE = ['running', 'budget_exhausted'] as const
const MIN_LEASE_MS = 90_000

function leaseExpiry(timeoutMs: number) {
  return new Date(Date.now() + Math.max(MIN_LEASE_MS, timeoutMs + 30_000)).toISOString()
}

async function retireIncompatibleRun(input: {
  supabase: SupabaseClient
  runId: string
  status: 'blocked' | 'failed'
  blockedStep: string
  error: string
}) {
  const now = new Date().toISOString()
  const retired = await input.supabase
    .from('operator_objective_runs')
    .update({
      status: input.status,
      blocked_step: input.blockedStep,
      completed_at: now,
      updated_at: now,
      lease_token: null,
      lease_expires_at: null,
    })
    .eq('id', input.runId)
    .or(`lease_token.is.null,lease_expires_at.lt.${now}`)
    .select('id')
    .maybeSingle()
  if (retired.error) throw new Error(`Could not retire incompatible objective run: ${retired.error.message}`)
  if (!retired.data) throw new Error('Objective run is already claimed by another worker')

  const event = await input.supabase.from('operator_objective_events').insert({
    run_id: input.runId,
    step_key: input.blockedStep,
    state: input.status === 'blocked' ? 'blocked' : 'failed',
    attempt: 0,
    error: input.error,
    occurred_at: now,
  })
  if (event.error) throw new Error(`Could not audit retired objective run: ${event.error.message}`)
}

export async function openOrResumeObjectiveRun(input: {
  supabase: SupabaseClient
  objectiveKey: string
  planVersion: string
  scopeKind: 'workspace' | 'founder'
  workspaceId: string | null
  actorKey: string
  maxTransitions: number
  timeoutMs: number
  maxRunAgeMs: number
  metadata?: Record<string, unknown>
}) {
  const { supabase } = input
  const runnerToken = randomUUID()
  const nowDate = new Date()
  const now = nowDate.toISOString()
  const leaseUntil = leaseExpiry(input.timeoutMs)

  let query = supabase
    .from('operator_objective_runs')
    .select('id,status,blocked_step,lease_token,lease_expires_at,metadata,plan_version,deadline_at,max_transitions')
    .eq('objective_key', input.objectiveKey)
    .eq('scope_kind', input.scopeKind)
    .eq('actor_key', input.actorKey)
    .in('status', [...RESUMABLE])
    .is('completed_at', null)
    .order('updated_at', { ascending: false })
    .limit(1)

  query = input.workspaceId ? query.eq('workspace_id', input.workspaceId) : query.is('workspace_id', null)
  let existing = await query.maybeSingle()
  if (existing.error) throw new Error(`Could not find resumable objective run: ${existing.error.message}`)

  if (existing.data && existing.data.plan_version !== input.planVersion) {
    await retireIncompatibleRun({
      supabase,
      runId: existing.data.id as string,
      status: 'blocked',
      blockedStep: '__plan_version__',
      error: `Objective plan changed from ${existing.data.plan_version} to ${input.planVersion}; old verified steps were not reused.`,
    })
    existing = { ...existing, data: null }
  } else if (existing.data?.deadline_at && Date.parse(existing.data.deadline_at as string) <= nowDate.getTime()) {
    await retireIncompatibleRun({
      supabase,
      runId: existing.data.id as string,
      status: 'failed',
      blockedStep: '__durable_deadline__',
      error: 'Objective exceeded its durable wall-clock deadline and was not resumed.',
    })
    existing = { ...existing, data: null }
  }

  let runId = existing.data?.id as string | undefined
  let metadata = (existing.data?.metadata ?? input.metadata ?? {}) as Record<string, unknown>
  let maxTransitions = Number(existing.data?.max_transitions ?? input.maxTransitions)
  if (!runId) {
    metadata = input.metadata ?? {}
    maxTransitions = input.maxTransitions
    const deadlineAt = new Date(nowDate.getTime() + Math.max(input.maxRunAgeMs, input.timeoutMs)).toISOString()
    const created = await supabase
      .from('operator_objective_runs')
      .insert({
        objective_key: input.objectiveKey,
        plan_version: input.planVersion,
        scope_kind: input.scopeKind,
        workspace_id: input.workspaceId,
        actor_key: input.actorKey,
        status: 'running',
        max_transitions: input.maxTransitions,
        timeout_ms: input.timeoutMs,
        deadline_at: deadlineAt,
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
    maxTransitions,
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
  const transitionBudgetTerminal = result.status === 'budget_exhausted' && result.budgetReason === 'transitions'
  const terminal = result.status === 'completed' || result.status === 'blocked' || result.status === 'failed' || transitionBudgetTerminal
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
        budgetReason: result.budgetReason ?? null,
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
