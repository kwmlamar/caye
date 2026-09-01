from pathlib import Path
from textwrap import dedent


def write(path: str, content: str) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(dedent(content).lstrip(), encoding="utf-8")


def replace(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"patch anchor not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


write("supabase/migrations/20260901065000_caye_direct_live_runs.sql", r'''
-- Durable founder-visible execution state for Caye Direct.
-- Threads remain the durable conversation object. Runs are temporary work
-- state that makes substantial autonomous work observable and controllable.
create table if not exists public.caye_direct_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  thread_id uuid not null references public.caye_direct_threads(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','planning','running','waiting_user','paused','completed','failed','cancelled')),
  objective text not null,
  stage_label text,
  control_requested text check (control_requested is null or control_requested in ('pause','cancel')),
  pending_steering text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists caye_direct_runs_thread_recent_idx
  on public.caye_direct_runs(thread_id, updated_at desc);
create index if not exists caye_direct_runs_active_idx
  on public.caye_direct_runs(status, updated_at desc)
  where status in ('queued','planning','running','waiting_user','paused');

create table if not exists public.caye_direct_run_events (
  id bigserial primary key,
  run_id uuid not null references public.caye_direct_runs(id) on delete cascade,
  kind text not null check (kind in ('status','activity','steering','control','artifact')),
  label text not null,
  created_at timestamptz not null default now()
);
create index if not exists caye_direct_run_events_run_idx
  on public.caye_direct_run_events(run_id, created_at asc);

alter table public.caye_direct_runs enable row level security;
alter table public.caye_direct_run_events enable row level security;
-- Founder routes use the service role after requireFounder(). No direct client
-- policy is added, keeping run control behind the same authenticated server
-- boundary as Direct itself.
''')

write("lib/caye-direct-runs.ts", r'''
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

async function event(supabase: SupabaseClient, runId: string, kind: DirectRunEvent['kind'], label: string): Promise<void> {
  const clean = label.trim().slice(0, 240)
  if (!clean) return
  await supabase.from('caye_direct_run_events').insert({ run_id: runId, kind, label: clean })
}

export function founderRunLabel(run: Pick<DirectRun, 'status' | 'stage_label' | 'control_requested'>): string {
  if (run.control_requested === 'pause') return 'Finishing the current step, then pausing…'
  if (run.control_requested === 'cancel') return 'Finishing the current step, then stopping…'
  if (run.status === 'waiting_user') return 'Needs you'
  if (run.status === 'paused') return 'Paused. Send an update to continue.'
  if (run.stage_label) return run.stage_label
  if (run.status === 'queued' || run.status === 'planning') return 'Starting work…'
  return 'Working…'
}

async function latestActive(supabase: SupabaseClient, threadId: string): Promise<DirectRun | null> {
  const { data, error } = await supabase.from('caye_direct_runs').select('*')
    .eq('thread_id', threadId).in('status', ACTIVE).order('updated_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error(`[caye-direct-runs] active lookup failed: ${error.message}`)
  if (!data) return null
  const run = data as DirectRun
  if ((run.status === 'running' || run.status === 'planning' || run.status === 'queued') && Date.now() - new Date(run.updated_at).getTime() > STALE_RUNNING_MS) {
    await supabase.from('caye_direct_runs').update({ status: 'failed', stage_label: 'Work stopped unexpectedly', completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', run.id).in('status', ['queued','planning','running'])
    await event(supabase, run.id, 'status', 'Work stopped unexpectedly')
    return null
  }
  return run
}

export async function beginDirectRun(supabase: SupabaseClient, args: { workspaceId: string; threadId: string; objective: string }): Promise<DirectRun> {
  const objective = args.objective.trim().slice(0, 4000) || 'Continue the founder request'
  const existing = await latestActive(supabase, args.threadId)
  if (existing) {
    if (existing.workspace_id !== args.workspaceId) throw new Error('Run workspace changed')
    if (existing.status === 'running' || existing.status === 'planning' || existing.status === 'queued') {
      throw new Error('Thread already has active work')
    }
    const nextObjective = `${existing.objective}\n\nFounder update: ${objective}`.slice(0, 8000)
    const now = new Date().toISOString()
    const { data, error } = await supabase.from('caye_direct_runs').update({
      status: 'running', objective: nextObjective, stage_label: 'Continuing with your update…',
      control_requested: null, pending_steering: null, completed_at: null, updated_at: now,
    }).eq('id', existing.id).in('status', ['paused','waiting_user']).select('*').single()
    if (error) throw new Error(`[caye-direct-runs] resume failed: ${error.message}`)
    await event(supabase, existing.id, 'status', 'Continuing with your update')
    return data as DirectRun
  }

  const { data, error } = await supabase.from('caye_direct_runs').insert({
    workspace_id: args.workspaceId, thread_id: args.threadId, status: 'running',
    objective, stage_label: 'Starting work…',
  }).select('*').single()
  if (error) throw new Error(`[caye-direct-runs] start failed: ${error.message}`)
  const run = data as DirectRun
  await event(supabase, run.id, 'status', 'Started work')
  return run
}

export async function setRunStage(supabase: SupabaseClient, runId: string, label: string): Promise<void> {
  const clean = label.trim().slice(0, 240)
  await supabase.from('caye_direct_runs').update({ stage_label: clean, updated_at: new Date().toISOString() }).eq('id', runId).in('status', ['queued','planning','running'])
  await event(supabase, runId, 'activity', clean)
}

export async function requestDirectRunControl(supabase: SupabaseClient, args: { threadId: string; runId: string; control: DirectRunControl }): Promise<boolean> {
  const now = new Date().toISOString()
  const label = args.control === 'pause' ? 'Pause requested' : 'Stop requested'
  const { data, error } = await supabase.from('caye_direct_runs').update({ control_requested: args.control, stage_label: args.control === 'pause' ? 'Finishing the current step, then pausing…' : 'Finishing the current step, then stopping…', updated_at: now })
    .eq('id', args.runId).eq('thread_id', args.threadId).in('status', ['queued','planning','running']).select('id').maybeSingle()
  if (error) throw new Error(`[caye-direct-runs] control failed: ${error.message}`)
  if (!data) return false
  await event(supabase, args.runId, 'control', label)
  return true
}

export async function steerDirectRun(supabase: SupabaseClient, args: { threadId: string; runId: string; message: string }): Promise<boolean> {
  const run = await latestActive(supabase, args.threadId)
  if (!run || run.id !== args.runId || !['queued','planning','running'].includes(run.status)) return false
  const clean = args.message.trim().slice(0, 4000)
  if (!clean) return false
  const pending = [run.pending_steering, clean].filter(Boolean).join('\n').slice(0, 8000)
  const { error } = await supabase.from('caye_direct_runs').update({ pending_steering: pending, stage_label: 'Updating the plan with your note…', updated_at: new Date().toISOString() }).eq('id', run.id).in('status', ['queued','planning','running'])
  if (error) throw new Error(`[caye-direct-runs] steer failed: ${error.message}`)
  await event(supabase, run.id, 'steering', 'Plan updated from your note')
  return true
}

export interface RunCheckpoint { decision: 'continue' | 'pause' | 'cancel'; steering: string | null }

export async function checkpointDirectRun(supabase: SupabaseClient, runId: string): Promise<RunCheckpoint> {
  const { data, error } = await supabase.from('caye_direct_runs').select('status, control_requested, pending_steering').eq('id', runId).maybeSingle()
  if (error) throw new Error(`[caye-direct-runs] checkpoint failed: ${error.message}`)
  if (!data) return { decision: 'cancel', steering: null }
  const control = data.control_requested as DirectRunControl | null
  const steering = typeof data.pending_steering === 'string' && data.pending_steering.trim() ? data.pending_steering.trim() : null
  const now = new Date().toISOString()
  if (control === 'cancel') {
    await supabase.from('caye_direct_runs').update({ status: 'cancelled', stage_label: 'Stopped', control_requested: null, pending_steering: null, completed_at: now, updated_at: now }).eq('id', runId).in('status', ['queued','planning','running'])
    await event(supabase, runId, 'status', 'Stopped at a safe boundary')
    return { decision: 'cancel', steering: null }
  }
  if (control === 'pause') {
    await supabase.from('caye_direct_runs').update({ status: 'paused', stage_label: 'Paused. Send an update to continue.', control_requested: null, completed_at: null, updated_at: now }).eq('id', runId).in('status', ['queued','planning','running'])
    await event(supabase, runId, 'status', 'Paused at a safe boundary')
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
  const checkpoint = await checkpointDirectRun(supabase, runId)
  if (checkpoint.decision === 'cancel') return 'cancelled'
  if (checkpoint.decision === 'pause') return 'paused'
  const now = new Date().toISOString()
  const { data } = await supabase.from('caye_direct_runs').update({ status: 'completed', stage_label: 'Done', completed_at: now, updated_at: now, pending_steering: null }).eq('id', runId).eq('status', 'running').select('id').maybeSingle()
  if (data) await event(supabase, runId, 'status', 'Work complete')
  return data ? 'completed' : 'failed'
}

export async function failDirectRun(supabase: SupabaseClient, runId: string): Promise<void> {
  const now = new Date().toISOString()
  const { data } = await supabase.from('caye_direct_runs').update({ status: 'failed', stage_label: 'Work stopped unexpectedly', completed_at: now, updated_at: now }).eq('id', runId).in('status', ['queued','planning','running']).select('id').maybeSingle()
  if (data) await event(supabase, runId, 'status', 'Work stopped unexpectedly')
}

export async function getDirectRun(supabase: SupabaseClient, threadId: string): Promise<{ run: DirectRun | null; events: DirectRunEvent[] }> {
  const run = await latestActive(supabase, threadId)
  if (!run) return { run: null, events: [] }
  const { data } = await supabase.from('caye_direct_run_events').select('id, kind, label, created_at').eq('run_id', run.id).order('created_at', { ascending: true }).limit(40)
  return { run, events: (data ?? []) as DirectRunEvent[] }
}

export async function attachRunProjection<T extends { id: string }>(supabase: SupabaseClient, threads: T[]): Promise<Array<T & { run_id: string | null; run_status: DirectRunStatus | null; run_label: string | null; run_objective: string | null; run_started_at: string | null }>> {
  if (threads.length === 0) return []
  const ids = threads.map((thread) => thread.id)
  const { data, error } = await supabase.from('caye_direct_runs').select('id, thread_id, status, objective, stage_label, control_requested, started_at, updated_at')
    .in('thread_id', ids).in('status', ACTIVE).order('updated_at', { ascending: false })
  if (error) throw new Error(`[caye-direct-runs] projection failed: ${error.message}`)
  const byThread = new Map<string, DirectRun>()
  for (const raw of data ?? []) {
    const run = raw as DirectRun
    if (!byThread.has(run.thread_id)) byThread.set(run.thread_id, run)
  }
  return threads.map((thread) => {
    const run = byThread.get(thread.id)
    return {
      ...thread,
      run_id: run?.id ?? null,
      run_status: run?.status ?? null,
      run_label: run ? founderRunLabel(run) : null,
      run_objective: run?.objective ?? null,
      run_started_at: run?.started_at ?? null,
    }
  })
}
''')

write("app/api/founder/caye-direct/threads/[id]/run/route.ts", r'''
import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase-server'
import { requireFounder } from '@/lib/founder'
import { getFounderThreadById, linkMessageToThread } from '@/lib/caye-direct-threads'
import { resolveFounderOperator } from '@/lib/operator-identity'
import { getDirectRun, requestDirectRunControl, steerDirectRun } from '@/lib/caye-direct-runs'

async function authorizedThread(req: NextRequest, threadId: string) {
  const user = await requireFounder(req)
  if (!user) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  const supabase = createServiceClient()
  const thread = await getFounderThreadById(supabase, threadId)
  if (!thread) return { error: NextResponse.json({ error: 'Thread not found' }, { status: 404 }) }
  return { supabase, thread, user }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorizedThread(req, id)
  if ('error' in auth) return auth.error
  const state = await getDirectRun(auth.supabase, id)
  return NextResponse.json(state)
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorizedThread(req, id)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  const action = body?.action === 'pause' ? 'pause' : body?.action === 'stop' ? 'cancel' : null
  const runId = typeof body?.runId === 'string' ? body.runId : null
  if (!action || !runId) return NextResponse.json({ error: 'runId and action are required' }, { status: 400 })
  const ok = await requestDirectRunControl(auth.supabase, { threadId: id, runId, control: action })
  if (!ok) return NextResponse.json({ error: 'Run is no longer active' }, { status: 409 })
  return NextResponse.json({ ok: true })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await authorizedThread(req, id)
  if ('error' in auth) return auth.error
  const body = await req.json().catch(() => null)
  const runId = typeof body?.runId === 'string' ? body.runId : null
  const message = typeof body?.message === 'string' ? body.message.trim() : ''
  if (!runId || !message) return NextResponse.json({ error: 'runId and message are required' }, { status: 400 })
  const ok = await steerDirectRun(auth.supabase, { threadId: id, runId, message })
  if (!ok) return NextResponse.json({ error: 'Run is no longer accepting updates' }, { status: 409 })

  // Persist steering as an ordinary founder message so the conversation stays
  // the canonical record. The running investigation consumes the same text at
  // its next safe continuation boundary.
  const operator = await resolveFounderOperator(auth.supabase, auth.thread.active_workspace_id)
  const { data: row, error } = await auth.supabase.from('caye_operator_messages').insert({
    workspace_id: auth.thread.active_workspace_id,
    direction: 'inbound', wa_message_id: null, body: message, intent: null,
    claude_format: { role: 'user', content: message }, operator_allowlist_id: operator?.id ?? null,
    operator_name: operator?.name ?? null, operator_role: operator?.role ?? 'founder', origin: 'dashboard',
  }).select('id').single()
  if (error || !row?.id) return NextResponse.json({ error: 'Could not save update' }, { status: 500 })
  await linkMessageToThread(auth.supabase, id, row.id, 'founder')
  return NextResponse.json({ ok: true })
}
''')

write("components/dashboard/caye-direct/LiveWorkPanel.tsx", r'''
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getSession } from '@/lib/supabase'

export interface LiveRunSummary {
  id: string
  status: 'queued' | 'planning' | 'running' | 'waiting_user' | 'paused' | 'completed' | 'failed' | 'cancelled'
  objective: string
  stage_label: string | null
  control_requested: 'pause' | 'cancel' | null
  started_at: string
}
interface RunEvent { id: number; kind: string; label: string; created_at: string }

function statusLabel(run: LiveRunSummary): string {
  if (run.control_requested === 'pause') return 'Pausing after this step'
  if (run.control_requested === 'cancel') return 'Stopping after this step'
  if (run.status === 'waiting_user') return 'Needs you'
  if (run.status === 'paused') return 'Paused'
  if (run.status === 'queued' || run.status === 'planning') return 'Starting'
  return 'Working'
}

export default function LiveWorkPanel({ threadId, onChanged }: { threadId: string; onChanged?: () => void }) {
  const [run, setRun] = useState<LiveRunSummary | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())

  const load = useCallback(async () => {
    const { session } = await getSession()
    if (!session) return
    const res = await fetch(`/api/founder/caye-direct/threads/${threadId}/run`, { headers: { Authorization: `Bearer ${session.access_token}` } })
    if (!res.ok) return
    const json = await res.json()
    setRun(json.run ?? null)
    setEvents(json.events ?? [])
    onChanged?.()
  }, [threadId, onChanged])

  useEffect(() => {
    void load()
    const poll = window.setInterval(() => void load(), 1800)
    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { window.clearInterval(poll); window.clearInterval(clock) }
  }, [load])

  const elapsed = useMemo(() => {
    if (!run) return ''
    const seconds = Math.max(0, Math.floor((now - new Date(run.started_at).getTime()) / 1000))
    if (seconds < 60) return `${seconds}s`
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  }, [run, now])

  async function control(action: 'pause' | 'stop') {
    if (!run || busy) return
    setBusy(true)
    try {
      const { session } = await getSession()
      if (!session) return
      await fetch(`/api/founder/caye-direct/threads/${threadId}/run`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ runId: run.id, action }),
      })
      await load()
    } finally { setBusy(false) }
  }

  if (!run) return null
  const visibleEvents = events.slice(-5)
  const controlsEnabled = ['queued','planning','running'].includes(run.status) && !run.control_requested

  return (
    <section aria-label="Key live work" style={{ margin: '10px max(20px, calc((100% - 720px) / 2)) 0', padding: '12px 14px', border: '1px solid rgba(78,190,206,0.18)', borderRadius: 14, background: 'rgba(78,190,206,0.045)', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: run.status === 'paused' || run.status === 'waiting_user' ? '#fbbf24' : '#4EBECE', boxShadow: '0 0 10px rgba(78,190,206,.45)' }} />
        <strong style={{ fontSize: 12.5, color: '#e4e4e7' }}>{statusLabel(run)}</strong>
        <span style={{ fontSize: 10, color: '#71717a', fontFamily: 'var(--font-mono)' }}>{elapsed}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button type="button" disabled={!controlsEnabled || busy} onClick={() => void control('pause')} style={buttonStyle}>Pause</button>
          <button type="button" disabled={!controlsEnabled || busy} onClick={() => void control('stop')} style={buttonStyle}>Stop</button>
        </div>
      </div>
      <div style={{ marginTop: 9 }}>
        <div style={kickerStyle}>Goal</div>
        <div style={{ marginTop: 3, fontSize: 12.5, lineHeight: 1.45, color: '#c8c8ce' }}>{run.objective}</div>
      </div>
      <div style={{ marginTop: 9 }}>
        <div style={kickerStyle}>Activity</div>
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {visibleEvents.length ? visibleEvents.map((item, index) => (
            <div key={item.id} style={{ fontSize: 11.5, color: index === visibleEvents.length - 1 ? '#d4d4d8' : '#85858d', lineHeight: 1.35 }}>
              {index === visibleEvents.length - 1 ? '●' : '✓'}&nbsp; {item.label}
            </div>
          )) : <div style={{ fontSize: 11.5, color: '#85858d' }}>{run.stage_label || 'Starting work…'}</div>}
        </div>
      </div>
      <div style={{ marginTop: 9, fontSize: 10.5, color: '#71717a' }}>
        Outputs appear in the conversation as Key creates them. You can steer Key from the composer while work is running.
      </div>
    </section>
  )
}

const kickerStyle = { color: '#66666f', fontSize: 9.5, fontFamily: 'var(--font-mono)', letterSpacing: '.08em', textTransform: 'uppercase' as const }
const buttonStyle = { border: '1px solid rgba(255,255,255,.1)', background: 'rgba(255,255,255,.04)', color: '#a1a1aa', borderRadius: 7, padding: '4px 8px', fontSize: 10.5, cursor: 'pointer' }
''')

# Thread list API: project transient run state onto ordinary threads.
replace("app/api/founder/caye-direct/threads/route.ts",
"import { createThread, listThreads } from '@/lib/caye-direct-threads'\n",
"import { createThread, listThreads } from '@/lib/caye-direct-threads'\nimport { attachRunProjection } from '@/lib/caye-direct-runs'\n")
replace("app/api/founder/caye-direct/threads/route.ts",
"    const threads = await listThreads(supabase, null, { q, status })\n    return NextResponse.json({ threads })",
"    const threads = await listThreads(supabase, null, { q, status })\n    const projected = status === 'active' ? await attachRunProjection(supabase, threads) : threads\n    return NextResponse.json({ threads: projected })")

# Sidebar: active work is a temporary group, never a permanent thread species.
replace("components/dashboard/founder-home/CommandSidebar.tsx",
"  pinned_at: string | null\n}",
"  pinned_at: string | null\n  run_id?: string | null\n  run_status?: 'queued' | 'planning' | 'running' | 'waiting_user' | 'paused' | null\n  run_label?: string | null\n  run_objective?: string | null\n  run_started_at?: string | null\n}")
replace("components/dashboard/founder-home/CommandSidebar.tsx",
"  const pinnedThreads = (threads ?? [])\n    .filter((thread) => thread.pinned_at)\n    .sort((a, b) => new Date(b.pinned_at as string).getTime() - new Date(a.pinned_at as string).getTime())\n  const recentThreads = (threads ?? [])\n    .filter((thread) => !thread.pinned_at)\n    .sort((a, b) => new Date(b.last_activity_at).getTime() - new Date(a.last_activity_at).getTime())",
"  const workingThreads = (threads ?? [])\n    .filter((thread) => !!thread.run_status)\n    .sort((a, b) => {\n      const priority = (status?: ThreadListItem['run_status']) => status === 'waiting_user' || status === 'paused' ? 0 : 1\n      return priority(a.run_status) - priority(b.run_status) || new Date(b.run_started_at ?? b.last_activity_at).getTime() - new Date(a.run_started_at ?? a.last_activity_at).getTime()\n    })\n  const pinnedThreads = (threads ?? [])\n    .filter((thread) => thread.pinned_at && !thread.run_status)\n    .sort((a, b) => new Date(b.pinned_at as string).getTime() - new Date(a.pinned_at as string).getTime())\n  const recentThreads = (threads ?? [])\n    .filter((thread) => !thread.pinned_at && !thread.run_status)\n    .sort((a, b) => new Date(b.last_activity_at).getTime() - new Date(a.last_activity_at).getTime())")
replace("components/dashboard/founder-home/CommandSidebar.tsx",
"          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{thread.title || 'New conversation'}</span>",
"          <span style={{ minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 1 }}>\n            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{thread.title || 'New conversation'}</span>\n            {thread.run_status && (\n              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', color: thread.run_status === 'waiting_user' || thread.run_status === 'paused' ? '#fbbf24' : '#6f9ea5', fontSize: 9.5, fontWeight: 500 }}>\n                {thread.run_label || 'Working…'}\n              </span>\n            )}\n          </span>")
replace("components/dashboard/founder-home/CommandSidebar.tsx",
"            {pinnedThreads.length > 0 && (",
"            {workingThreads.length > 0 && (\n              <div>\n                <SectionLabel compact>Working</SectionLabel>\n                {workingThreads.map((thread) => renderThreadRow(thread))}\n              </div>\n            )}\n\n            {pinnedThreads.length > 0 && (")

# Founder shell: poll thread projections, render live work in the selected thread,
# and route steering messages into the active run instead of launching a race.
replace("components/dashboard/founder-home/FounderHome.tsx",
"import CayeDirectThread from '@/components/dashboard/caye-direct/CayeDirectThread'\n",
"import CayeDirectThread from '@/components/dashboard/caye-direct/CayeDirectThread'\nimport LiveWorkPanel from '@/components/dashboard/caye-direct/LiveWorkPanel'\n")
replace("components/dashboard/founder-home/FounderHome.tsx",
"  // ── Operators (\"Team\")",
"  useEffect(() => {\n    const timer = window.setInterval(async () => {\n      const list = await loadThreads()\n      if (list) setThreads(list)\n    }, 2500)\n    return () => window.clearInterval(timer)\n  }, [loadThreads])\n\n  // ── Operators (\"Team\")")
replace("components/dashboard/founder-home/FounderHome.tsx",
"  const selectedThread = activeView.type === 'thread' ? threads?.find((t) => t.id === activeView.id) ?? null : null",
"  async function steerThreadRun(thread: ThreadListItem, message: string): Promise<boolean> {\n    if (!thread.run_id || !message.trim()) return false\n    const { session } = await getSession()\n    if (!session) return false\n    const res = await fetch(`/api/founder/caye-direct/threads/${thread.id}/run`, {\n      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },\n      body: JSON.stringify({ runId: thread.run_id, message: message.trim() }),\n    })\n    if (res.ok) {\n      const list = await loadThreads()\n      if (list) setThreads(list)\n    }\n    return res.ok\n  }\n\n  const selectedThread = activeView.type === 'thread' ? threads?.find((t) => t.id === activeView.id) ?? null : null")
old_thread_render = """          ) : selectedThread ? (\n            <CayeDirectThread\n              key={selectedThread.id}\n              mode=\"thread\"\n              workspaceId={workspaceId}\n              threadId={selectedThread.id}\n              threadTitle={selectedThread.title}\n              autoFocusComposer\n              composerVisible\n              scrollToLatest\n              onThreadMeta={(meta) => updateThreadMeta(selectedThread.id, meta)}\n              onArchive={() => archiveThread(selectedThread.id)}\n              leadingCard={!snapshotDismissed ? (\n                <SnapshotCard\n                  data={data}\n                  today={today}\n                  weekLabel={weekOffset === 0 ? 'Bookings this week' : 'Bookings shown'}\n                  onReviewAttention={goToConversation}\n                  onDismiss={() => setSnapshotDismissed(true)}\n                />\n              ) : undefined}\n            />\n"""
new_thread_render = """          ) : selectedThread ? (\n            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>\n              <LiveWorkPanel\n                threadId={selectedThread.id}\n                onChanged={() => { void loadThreads().then((list) => { if (list) setThreads(list) }) }}\n              />\n              <div style={{ flex: 1, minHeight: 0 }}>\n                <CayeDirectThread\n                  key={selectedThread.id}\n                  mode=\"thread\"\n                  workspaceId={workspaceId}\n                  threadId={selectedThread.id}\n                  threadTitle={selectedThread.title}\n                  autoFocusComposer\n                  composerVisible\n                  scrollToLatest\n                  onSteer={(message) => steerThreadRun(selectedThread, message)}\n                  onThreadMeta={(meta) => updateThreadMeta(selectedThread.id, meta)}\n                  onArchive={() => archiveThread(selectedThread.id)}\n                  leadingCard={!snapshotDismissed ? (\n                    <SnapshotCard\n                      data={data}\n                      today={today}\n                      weekLabel={weekOffset === 0 ? 'Bookings this week' : 'Bookings shown'}\n                      onReviewAttention={goToConversation}\n                      onDismiss={() => setSnapshotDismissed(true)}\n                    />\n                  ) : undefined}\n                />\n              </div>\n            </div>\n"""
replace("components/dashboard/founder-home/FounderHome.tsx", old_thread_render, new_thread_render)

# Direct composer: keep text steering available while an active turn is running.
replace("components/dashboard/caye-direct/CayeDirectThread.tsx",
"  leadingCard?: ReactNode\n}",
"  leadingCard?: ReactNode\n  /** While a durable run is active, typed updates steer that run at its next safe boundary instead of racing a second agent turn. */\n  onSteer?: (message: string) => Promise<boolean>\n}")
replace("components/dashboard/caye-direct/CayeDirectThread.tsx",
"  function send(text: string): Promise<string | null> {\n    if (mode !== 'thread') return Promise.resolve(null)\n    const readyIds = attachments.filter((a) => a.status === 'ready' && a.artifactId).map((a) => a.artifactId!)\n    return runTurn(text, { endpoint: `/api/founder/caye-direct/threads/${props.threadId}`, isTyped: true }, readyIds)\n  }",
"  async function send(text: string): Promise<string | null> {\n    if (mode !== 'thread') return null\n    const trimmed = text.trim()\n    if (sending && props.onSteer && trimmed && attachments.length === 0) {\n      const accepted = await props.onSteer(trimmed)\n      if (accepted) {\n        setInput('')\n        setMessages((prev) => [...prev, { id: `steer-${Date.now()}`, direction: 'inbound', body: trimmed, created_at: new Date().toISOString(), origin: 'dashboard', operator_role: 'founder' }])\n      }\n      return null\n    }\n    const readyIds = attachments.filter((a) => a.status === 'ready' && a.artifactId).map((a) => a.artifactId!)\n    return runTurn(text, { endpoint: `/api/founder/caye-direct/threads/${props.threadId}`, isTyped: true }, readyIds)\n  }")
replace("components/dashboard/caye-direct/CayeDirectThread.tsx", "                disabled={sending}\n                onFocus={() => setComposerFocused(true)}", "                disabled={false}\n                onFocus={() => setComposerFocused(true)}")
replace("components/dashboard/caye-direct/CayeDirectThread.tsx", "                disabled={sending || !canSend}\n                title=\"Send\"", "                disabled={!canSend}\n                title={sending ? 'Steer current work' : 'Send'}")
replace("components/dashboard/caye-direct/CayeDirectThread.tsx", "                className={`caye-direct-send${canSend && !sending ? ' is-ready' : ''}`}", "                className={`caye-direct-send${canSend ? ' is-ready' : ''}`}")
replace("components/dashboard/caye-direct/CayeDirectThread.tsx", "                  stroke={canSend && !sending ? '#4EBECE' : 'rgba(244,244,245,0.45)'}", "                  stroke={canSend ? '#4EBECE' : 'rgba(244,244,245,0.45)'}")

# Persist run lifecycle around the existing authenticated Direct turn.
replace("app/api/founder/caye-direct/threads/[id]/route.ts",
"import { startCayeDirectActivity, updateCayeDirectActivity } from '@/lib/caye-direct-activity'\n",
"import { startCayeDirectActivity, updateCayeDirectActivity } from '@/lib/caye-direct-activity'\nimport { beginDirectRun, finishDirectRun, failDirectRun, setRunStage } from '@/lib/caye-direct-runs'\n")
replace("app/api/founder/caye-direct/threads/[id]/route.ts",
"  let activityId: string | null = null\n  try {",
"  let activityId: string | null = null\n  let runId: string | null = null\n  try {")
replace("app/api/founder/caye-direct/threads/[id]/route.ts",
"    const requestedMode = VALID_REQUESTED_MODES.find((m) => m === model) ?? 'auto'\n    activityId = await startCayeDirectActivity({",
"    const requestedMode = VALID_REQUESTED_MODES.find((m) => m === model) ?? 'auto'\n    const run = await beginDirectRun(supabase, { workspaceId: turnWorkspaceId, threadId, objective: message ?? (attachments?.length ? 'Review the attached files' : 'Continue this work') })\n    runId = run.id\n    await setRunStage(supabase, run.id, attachments?.length ? 'Reviewing the files…' : 'Understanding the request…')\n    activityId = await startCayeDirectActivity({")
replace("app/api/founder/caye-direct/threads/[id]/route.ts",
"      { requestedMode, founderUserId: user.id, activityId },",
"      { requestedMode, founderUserId: user.id, activityId, directRunId: runId },")
replace("app/api/founder/caye-direct/threads/[id]/route.ts",
"    await updateCayeDirectActivity(activityId, { kind: 'completed' })\n    return NextResponse.json({",
"    await updateCayeDirectActivity(activityId, { kind: 'completed' })\n    if (runId) await finishDirectRun(supabase, runId)\n    return NextResponse.json({")
replace("app/api/founder/caye-direct/threads/[id]/route.ts",
"  } catch (err) {\n    await updateCayeDirectActivity(activityId, { kind: 'failed' })",
"  } catch (err) {\n    await updateCayeDirectActivity(activityId, { kind: 'failed' })\n    if (runId) await failDirectRun(supabase, runId)")

# Founder turn passes a durable checkpoint into the bounded investigation loop.
replace("lib/caye-agent/founder-thread-turn.ts",
"import { mark } from '@/lib/caye-voice/latency'\n",
"import { mark } from '@/lib/caye-voice/latency'\nimport { checkpointDirectRun, setRunStage } from '@/lib/caye-direct-runs'\n")
replace("lib/caye-agent/founder-thread-turn.ts",
"  activityId?: string | null\n}",
"  activityId?: string | null\n  /** Durable Direct run used for founder-visible progress and cooperative pause/stop checkpoints. */\n  directRunId?: string | null\n}")
replace("lib/caye-agent/founder-thread-turn.ts",
"  const agentResult = await runInvestigation(\n    supabase,\n    {\n      workspaceId,\n      threadId,\n      message,\n      callerName,\n      operatorId: operator?.id ?? null,\n      engineeringOrigin: { threadId, messageId: inboundRow.id },\n      channel: 'dashboard',\n      userMessageOverride,\n    },",
"  if (options?.directRunId) await setRunStage(supabase, options.directRunId, 'Researching and working through the request…')\n  const agentResult = await runInvestigation(\n    supabase,\n    {\n      workspaceId,\n      threadId,\n      message,\n      callerName,\n      operatorId: operator?.id ?? null,\n      engineeringOrigin: { threadId, messageId: inboundRow.id },\n      channel: 'dashboard',\n      userMessageOverride,\n      runCheckpoint: options?.directRunId ? () => checkpointDirectRun(supabase, options.directRunId!) : undefined,\n    },")

# Investigation: honor control only between fully persisted passes, and fold
# steering into the next continuation objective without exposing hidden thought.
replace("lib/caye-agent/investigation.ts",
"  userMessageOverride?: Anthropic.MessageParam['content']\n}",
"  userMessageOverride?: Anthropic.MessageParam['content']\n  /** Checked only between persisted passes. Never interrupts an in-flight model/tool/persistence step. */\n  runCheckpoint?: () => Promise<{ decision: 'continue' | 'pause' | 'cancel'; steering: string | null }>\n}")
replace("lib/caye-agent/investigation.ts",
"  let continuations = 0\n  while (agentResult.ranOutOfIterations && continuations < MAX_INVESTIGATION_CONTINUATIONS) {\n    continuations++\n    agentResult = await cayeAgent({",
"  let continuations = 0\n  let currentObjective = input.message\n  while (agentResult.ranOutOfIterations && continuations < MAX_INVESTIGATION_CONTINUATIONS) {\n    if (input.runCheckpoint) {\n      const checkpoint = await input.runCheckpoint()\n      if (checkpoint.decision !== 'continue') {\n        const stoppedText = checkpoint.decision === 'pause'\n          ? 'Paused. I finished the current step safely. Send me an update when you want me to continue.'\n          : 'Stopped. I finished the current step safely and did not start another one.'\n        const finalTurn: Anthropic.MessageParam = { role: 'assistant', content: [{ type: 'text', text: stoppedText }] }\n        await persistPassTurns([finalTurn], [])\n        return { ...agentResult, ranOutOfIterations: false, replyText: stoppedText }\n      }\n      if (checkpoint.steering) currentObjective = `${currentObjective}\\n\\nFounder update: ${checkpoint.steering}`\n    }\n    continuations++\n    agentResult = await cayeAgent({")
replace("lib/caye-agent/investigation.ts",
"      userMessage: input.message,\n      callerRole: 'founder',",
"      userMessage: currentObjective,\n      callerRole: 'founder',")
replace("lib/caye-agent/investigation.ts",
"      investigation: { id: investigationId, isContinuation: true, objective: input.message },",
"      investigation: { id: investigationId, isContinuation: true, objective: currentObjective },")

# Focused helper tests. These are deliberately pure enough to catch UI wording
# regressions without needing a service-role database in unit tests.
write("lib/caye-direct-runs.test.ts", r'''
import { describe, expect, it } from 'vitest'
import { founderRunLabel } from './caye-direct-runs'

describe('founderRunLabel', () => {
  it('puts control requests ahead of generic work state', () => {
    expect(founderRunLabel({ status: 'running', stage_label: 'Researching…', control_requested: 'pause' })).toContain('pausing')
    expect(founderRunLabel({ status: 'running', stage_label: 'Researching…', control_requested: 'cancel' })).toContain('stopping')
  })
  it('uses founder-oriented needs-you language', () => {
    expect(founderRunLabel({ status: 'waiting_user', stage_label: null, control_requested: null })).toBe('Needs you')
  })
  it('uses semantic stage copy instead of implementation details', () => {
    expect(founderRunLabel({ status: 'running', stage_label: 'Comparing pricing and positioning…', control_requested: null })).toBe('Comparing pricing and positioning…')
  })
})
''')

print('live work patch applied')
