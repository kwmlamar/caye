import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ObjectiveEvent, ObjectiveRunResult } from './objective-run'

const RESUMABLE = ['running', 'budget_exhausted'] as const

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
  let query = supabase
    .from('operator_objective_runs')
    .select('id,status,blocked_step')
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
  if (!runId) {
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
        metadata: input.metadata ?? {},
      })
      .select('id')
      .single()
    if (created.error || !created.data) throw new Error(`Could not create objective run: ${created.error?.message ?? 'unknown error'}`)
    runId = created.data.id as string
  } else if (existing.data?.status === 'budget_exhausted') {
    const resumed = await supabase
      .from('operator_objective_runs')
      .update({ status: 'running', blocked_step: null, updated_at: new Date().toISOString() })
      .eq('id', runId)
    if (resumed.error) throw new Error(`Could not resume objective run: ${resumed.error.message}`)
  }

  const verified = await supabase
    .from('operator_objective_events')
    .select('step_key')
    .eq('run_id', runId)
    .eq('state', 'verified')
  if (verified.error) throw new Error(`Could not read objective progress: ${verified.error.message}`)

  return { runId, completedSteps: new Set((verified.data ?? []).map((row) => row.step_key as string)) }
}

export async function persistObjectiveEvent(supabase: SupabaseClient, runId: string, event: ObjectiveEvent) {
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

  const touched = await supabase
    .from('operator_objective_runs')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', runId)
  if (touched.error) throw new Error(`Could not update objective heartbeat: ${touched.error.message}`)
}

export async function finalizeObjectiveRun(supabase: SupabaseClient, runId: string, result: ObjectiveRunResult) {
  const terminal = result.status === 'completed' || result.status === 'blocked' || result.status === 'failed'
  const updated = await supabase
    .from('operator_objective_runs')
    .update({
      status: result.status,
      blocked_step: result.blockedStep ?? null,
      updated_at: new Date().toISOString(),
      completed_at: terminal ? new Date().toISOString() : null,
      metadata: { completedSteps: result.completedSteps },
    })
    .eq('id', runId)
  if (updated.error) throw new Error(`Could not finalize objective run: ${updated.error.message}`)
}
