import 'server-only'
import type { createServiceClient } from '@/lib/supabase-server'

type SupabaseClient = ReturnType<typeof createServiceClient>

export type DirectRunStatus = 'queued' | 'planning' | 'running' | 'waiting_user' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type DirectRunControl = 'pause' | 'cancel'

export interface DirectRun {
  id: string
  workspace_id: string
  thread_id: string
  status: DirectRunStatus
  objective: string
  stage_label: string | null
  control_requested: DirectRunControl | null
  pending_steering: string | null
  linked_research_question_id: string | null
  linked_research_run_id: string | null
  started_at: string
  completed_at: string | null
  updated_at: string
}

export interface DirectRunEvent {
  id: number
  kind: 'status' | 'activity' | 'steering' | 'control' | 'artifact'
  label: string
  created_at: string
}

const ACTIVE: DirectRunStatus[] = ['queued', 'planning', 'running', 'waiting_user', 'paused']
const STALE_RUNNING_MS = 15 * 60_000

async function addEvent(supabase: SupabaseClient, runId: string, kind: DirectRunEvent['kind'], label: string): Promise<void> {
  const clean = label.trim().slice(0, 240)
  if (!clean) return
  const { error } = await supabase.from('caye_direct_run_events').insert({ run_id: runId, kind, label: clean })
  if (error) console.warn('[caye-direct-runs] event failed:', error.message)
}

export function founderRunLabel(run: Pick<DirectRun, 'status' | 'stage_label' | 'control_requested'>): string {
  if (run.control_requested === 'pause') return 'Finishing this step, then pausing…'
  if (run.control_requested === 'cancel') return 'Finishing this step, then stopping…'
  if (run.status === 'waiting_user') return 'Needs you'
  if (run.status === 'paused') return 'Paused'
  if (run.status === 'queued' || run.status === 'planning') return 'Starting…'
  return run.stage_label || 'Working…'
}

export function researchRunStage(status: string | null): string | null {
  if (status === 'queued') return 'Research queued…'
  if (status === 'running') return 'Researching sources…'
  if (status === 'completed') return 'Research complete'
  if (status === 'partial') return 'Research finished with gaps'
  if (status === 'failed') return 'Research stopped before completion'
  return null
}

async function linkedResearchStatus(supabase: SupabaseClient, run: Pick<DirectRun, 'linked_research_run_id'>): Promise<string | null> {
  if (!run.linked_research_run_id) return null
  const { data, error } = await supabase.from('research_runs').select('status').eq('id', run.linked_research_run_id).maybeSingle()
  if (error) throw new Error(`[caye-direct-runs] linked research lookup failed: ${error.message}`)
  return typeof data?.status === 'string' ? data.status : null
}

async function markStaleRunningFailed(supabase: SupabaseClient, run: DirectRun): Promise<boolean> {
  if (!['queued', 'planning', 'running'].includes(run.status)) return false

  const researchStatus = await linkedResearchStatus(supabase, run)
  if (researchStatus === 'queued' || researchStatus === 'running') {
    const stage = researchRunStage(researchStatus)!
    if (run.stage_label !== stage) {
      const now = new Date().toISOString()
      await supabase.from('caye_direct_runs').update({ stage_label: stage, updated_at: now }).eq('id', run.id).eq('status', 'running')
      await addEvent(supabase, run.id, 'activity', stage)
    }
    return false
  }
  if (researchStatus === 'completed') {
    const now = new Date().toISOString()
    const { data } = await supabase.from('caye_direct_runs').update({ status: 'completed', stage_label: 'Research complete', completed_at: now, updated_at: now }).eq('id', run.id).in('status', ['queued','planning','running']).select('id').maybeSingle()
    if (data) await addEvent(supabase, run.id, 'status', 'Research complete')
    return !!data
  }
  if (researchStatus === 'partial' || researchStatus === 'failed') {
    const now = new Date().toISOString()
    const stage = researchRunStage(researchStatus)!
    const { data } = await supabase.from('caye_direct_runs').update({ status: 'failed', stage_label: stage, completed_at: now, updated_at: now }).eq('id', run.id).in('status', ['queued','planning','running']).select('id').maybeSingle()
    if (data) await addEvent(supabase, run.id, 'status', stage)
    return !!data
  }

  if (Date.now() - new Date(run.updated_at).getTime() <= STALE_RUNNING_MS) return false
  const now = new Date().toISOString()
  const { data } = await supabase.from('caye_direct_runs').update({
    status: 'failed', stage_label: 'Work stopped unexpectedly', completed_at: now, updated_at: now,
  }).eq('id', run.id).in('status', ['queued','planning','running']).select('id').maybeSingle()
  if (data) await addEvent(supabase, run.id, 'status', 'Work stopped unexpectedly')
  return !!data
}

export async function latestActiveDirectRun(supabase: SupabaseClient, threadId: string): Promise<DirectRun | null> {
  const { data, error } = await supabase.from('caye_direct_runs').select('*')
    .eq('thread_id', threadId).in('status', ACTIVE).order('updated_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error(`[caye-direct-runs] active lookup failed: ${error.message}`)
  if (!data) return null
  const run = data as DirectRun
  if (await markStaleRunningFailed(supabase, run)) return null
  return run
}

export async function beginDirectRun(supabase: SupabaseClient, args: { workspaceId: string; threadId: string; objective: string }): Promise<DirectRun> {
  const objective = args.objective.trim().slice(0, 4000) || 'Continue the founder request'
  const existing = await latestActiveDirectRun(supabase, args.threadId)
  if (existing) {
    if (existing.workspace_id !== args.workspaceId) throw new Error('Run workspace changed')
    if (!['paused', 'waiting_user'].includes(existing.status)) throw new Error('Thread already has active work')
    const now = new Date().toISOString()
    const nextObjective = `${existing.objective}\n\nFounder update: ${objective}`.slice(0, 8000)
    const { data, error } = await supabase.from('caye_direct_runs').update({
      status: 'running', objective: nextObjective, stage_label: 'Continuing with your update…',
      control_requested: null, pending_steering: null, completed_at: null, updated_at: now,
    }).eq('id', existing.id).in('status', ['paused','waiting_user']).select('*').single()
    if (error) throw new Error(`[caye-direct-runs] resume failed: ${error.message}`)
    await addEvent(supabase, existing.id, 'status', 'Continuing with your update')
    return data as DirectRun
  }

  const { data, error } = await supabase.from('caye_direct_runs').insert({
    workspace_id: args.workspaceId, thread_id: args.threadId, status: 'running', objective,
    stage_label: 'Starting work…',
  }).select('*').single()
  if (error) throw new Error(`[caye-direct-runs] start failed: ${error.message}`)
  const run = data as DirectRun
  await addEvent(supabase, run.id, 'status', 'Started work')
  return run
}

export async function linkDirectRunToResearch(supabase: SupabaseClient, args: { directRunId: string; questionId: string; researchRunId: string }): Promise<void> {
  const now = new Date().toISOString()
  const { data, error } = await supabase.from('caye_direct_runs').update({
    linked_research_question_id: args.questionId,
    linked_research_run_id: args.researchRunId,
    status: 'running',
    stage_label: 'Research queued…',
    completed_at: null,
    updated_at: now,
  }).eq('id', args.directRunId).in('status', ['queued','planning','running']).select('id').maybeSingle()
  if (error) throw new Error(`[caye-direct-runs] research link failed: ${error.message}`)
  if (!data) throw new Error('[caye-direct-runs] active Direct run was unavailable for research linkage')
  await addEvent(supabase, args.directRunId, 'activity', 'Research queued')
}

export async function syncDirectRunForResearchRun(supabase: SupabaseClient, researchRunId: string, researchStatus: 'completed' | 'failed'): Promise<void> {
  const { data, error } = await supabase.from('caye_direct_runs').select('id,status,control_requested')
    .eq('linked_research_run_id', researchRunId).in('status', ['queued','planning','running'])
  if (error) throw new Error(`[caye-direct-runs] research sync lookup failed: ${error.message}`)
  for (const direct of data ?? []) {
    const now = new Date().toISOString()
    if (direct.control_requested === 'cancel') {
      await supabase.from('caye_direct_runs').update({ status: 'cancelled', stage_label: 'Stopped', control_requested: null, completed_at: now, updated_at: now }).eq('id', direct.id)
      await addEvent(supabase, direct.id, 'status', 'Stopped after the current research step')
      continue
    }
    if (direct.control_requested === 'pause') {
      await supabase.from('caye_direct_runs').update({ status: 'paused', stage_label: 'Paused', control_requested: null, completed_at: null, updated_at: now }).eq('id', direct.id)
      await addEvent(supabase, direct.id, 'status', 'Paused after the current research step')
      continue
    }
    if (researchStatus === 'completed') {
      await supabase.from('caye_direct_runs').update({ status: 'completed', stage_label: 'Research complete', completed_at: now, updated_at: now }).eq('id', direct.id)
      await addEvent(supabase, direct.id, 'status', 'Research complete')
    } else {
      await supabase.from('caye_direct_runs').update({ status: 'failed', stage_label: 'Research stopped before completion', completed_at: now, updated_at: now }).eq('id', direct.id)
      await addEvent(supabase, direct.id, 'status', 'Research stopped before completion')
    }
  }
}

export async function setRunStage(supabase: SupabaseClient, runId: string, label: string): Promise<void> {
  const clean = label.trim().slice(0, 240)
  const { data } = await supabase.from('caye_direct_runs').update({ stage_label: clean, updated_at: new Date().toISOString() })
    .eq('id', runId).eq('status', 'running').select('id').maybeSingle()
  if (data) await addEvent(supabase, runId, 'activity', clean)
}

export async function requestDirectRunControl(supabase: SupabaseClient, args: { threadId: string; runId: string; control: DirectRunControl }): Promise<boolean> {
  const label = args.control === 'pause' ? 'Pause requested' : 'Stop requested'
  const stage = args.control === 'pause' ? 'Finishing this step, then pausing…' : 'Finishing this step, then stopping…'
  const { data, error } = await supabase.from('caye_direct_runs').update({
    control_requested: args.control, stage_label: stage, updated_at: new Date().toISOString(),
  }).eq('id', args.runId).eq('thread_id', args.threadId).in('status', ['queued','planning','running']).select('id').maybeSingle()
  if (error) throw new Error(`[caye-direct-runs] control failed: ${error.message}`)
  if (!data) return false
  await addEvent(supabase, args.runId, 'control', label)
  return true
}

export async function steerDirectRun(supabase: SupabaseClient, args: { threadId: string; runId: string; message: string }): Promise<boolean> {
  const run = await latestActiveDirectRun(supabase, args.threadId)
  if (!run || run.id !== args.runId || !['queued','planning','running'].includes(run.status)) return false
  const clean = args.message.trim().slice(0, 4000)
  if (!clean) return false
  const pending = [run.pending_steering, clean].filter(Boolean).join('\n').slice(0, 8000)
  const { data, error } = await supabase.from('caye_direct_runs').update({
    pending_steering: pending, stage_label: 'Updating the plan with your note…', updated_at: new Date().toISOString(),
  }).eq('id', run.id).in('status', ['queued','planning','running']).select('id').maybeSingle()
  if (error) throw new Error(`[caye-direct-runs] steer failed: ${error.message}`)
  if (!data) return false
  await addEvent(supabase, run.id, 'steering', 'Plan updated from your note')
  return true
}

export interface DirectRunCheckpoint { decision: 'continue' | 'pause' | 'cancel'; steering: string | null }

export async function checkpointDirectRun(supabase: SupabaseClient, runId: string): Promise<DirectRunCheckpoint> {
  const { data, error } = await supabase.from('caye_direct_runs').select('status, control_requested, pending_steering').eq('id', runId).maybeSingle()
  if (error) throw new Error(`[caye-direct-runs] checkpoint failed: ${error.message}`)
  if (!data) return { decision: 'cancel', steering: null }
  if (data.status === 'cancelled') return { decision: 'cancel', steering: null }
  if (data.status === 'paused') return { decision: 'pause', steering: typeof data.pending_steering === 'string' ? data.pending_steering : null }
  const control = data.control_requested as DirectRunControl | null
  const steering = typeof data.pending_steering === 'string' && data.pending_steering.trim() ? data.pending_steering.trim() : null
  const now = new Date().toISOString()
  if (control === 'cancel') {
    await supabase.from('caye_direct_runs').update({ status: 'cancelled', stage_label: 'Stopped', control_requested: null, pending_steering: null, completed_at: now, updated_at: now }).eq('id', runId).in('status', ['queued','planning','running'])
    await addEvent(supabase, runId, 'status', 'Stopped at a safe boundary')
    return { decision: 'cancel', steering: null }
  }
  if (control === 'pause') {
    await supabase.from('caye_direct_runs').update({ status: 'paused', stage_label: 'Paused', control_requested: null, completed_at: null, updated_at: now }).eq('id', runId).in('status', ['queued','planning','running'])
    await addEvent(supabase, runId, 'status', 'Paused at a safe boundary')
    return { decision: 'pause', steering }
  }
  if (steering) {
    await supabase.from('caye_direct_runs').update({ pending_steering: null, stage_label: 'Continuing with your update…', updated_at: now }).eq('id', runId).eq('status', 'running')
    return { decision: 'continue', steering }
  }
  await supabase.from('caye_direct_runs').update({ updated_at: now }).eq('id', runId).eq('status', 'running')
  return { decision: 'continue', steering: null }
}

export async function finishDirectRun(supabase: SupabaseClient, runId: string): Promise<DirectRunStatus> {
  const { data: current, error } = await supabase.from('caye_direct_runs').select('linked_research_run_id').eq('id', runId).maybeSingle()
  if (error) throw new Error(`[caye-direct-runs] finish lookup failed: ${error.message}`)
  if (current?.linked_research_run_id) {
    const { data: research, error: researchError } = await supabase.from('research_runs').select('status').eq('id', current.linked_research_run_id).maybeSingle()
    if (researchError) throw new Error(`[caye-direct-runs] finish research lookup failed: ${researchError.message}`)
    if (research?.status === 'queued' || research?.status === 'running') {
      const stage = researchRunStage(research.status)!
      await supabase.from('caye_direct_runs').update({ stage_label: stage, updated_at: new Date().toISOString() }).eq('id', runId).eq('status', 'running')
      return 'running'
    }
    if (research?.status === 'failed' || research?.status === 'partial') {
      const now = new Date().toISOString()
      await supabase.from('caye_direct_runs').update({ status: 'failed', stage_label: researchRunStage(research.status), completed_at: now, updated_at: now }).eq('id', runId).eq('status', 'running')
      await addEvent(supabase, runId, 'status', researchRunStage(research.status)!)
      return 'failed'
    }
  }

  const checkpoint = await checkpointDirectRun(supabase, runId)
  if (checkpoint.decision === 'cancel') return 'cancelled'
  if (checkpoint.decision === 'pause') return 'paused'
  const now = new Date().toISOString()
  const { data } = await supabase.from('caye_direct_runs').update({
    status: 'completed', stage_label: 'Done', completed_at: now, updated_at: now, pending_steering: null,
  }).eq('id', runId).eq('status', 'running').select('id').maybeSingle()
  if (data) await addEvent(supabase, runId, 'status', 'Work complete')
  return data ? 'completed' : 'failed'
}

export async function failDirectRun(supabase: SupabaseClient, runId: string): Promise<void> {
  const { data: current } = await supabase.from('caye_direct_runs').select('linked_research_run_id').eq('id', runId).maybeSingle()
  if (current?.linked_research_run_id) {
    const { data: research } = await supabase.from('research_runs').select('status').eq('id', current.linked_research_run_id).maybeSingle()
    if (research?.status === 'queued' || research?.status === 'running') {
      await supabase.from('caye_direct_runs').update({ stage_label: researchRunStage(research.status), updated_at: new Date().toISOString() }).eq('id', runId).eq('status', 'running')
      return
    }
  }
  const now = new Date().toISOString()
  const { data } = await supabase.from('caye_direct_runs').update({
    status: 'failed', stage_label: 'Work stopped unexpectedly', completed_at: now, updated_at: now,
  }).eq('id', runId).in('status', ['queued','planning','running']).select('id').maybeSingle()
  if (data) await addEvent(supabase, runId, 'status', 'Work stopped unexpectedly')
}

export async function getDirectRun(supabase: SupabaseClient, threadId: string): Promise<{ run: DirectRun | null; events: DirectRunEvent[] }> {
  const run = await latestActiveDirectRun(supabase, threadId)
  if (!run) return { run: null, events: [] }
  const { data } = await supabase.from('caye_direct_run_events').select('id, kind, label, created_at')
    .eq('run_id', run.id).order('created_at', { ascending: true }).limit(40)
  return { run, events: (data ?? []) as DirectRunEvent[] }
}

export async function listWorkspaceDirectRuns(supabase: SupabaseClient, workspaceId: string): Promise<DirectRun[]> {
  const { data, error } = await supabase.from('caye_direct_runs').select('*')
    .eq('workspace_id', workspaceId).in('status', ACTIVE).order('updated_at', { ascending: false }).limit(50)
  if (error) throw new Error(`[caye-direct-runs] workspace list failed: ${error.message}`)
  const visible: DirectRun[] = []
  for (const raw of data ?? []) {
    const run = raw as DirectRun
    if (!(await markStaleRunningFailed(supabase, run))) visible.push(run)
  }
  return visible
}
