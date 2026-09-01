'use client'

import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react'
import { getSession } from '@/lib/supabase'
import CayeDirectThreadBase from './CayeDirectThreadBase'

export default function CayeDirectThread(props: ComponentProps<typeof CayeDirectThreadBase>) {
  if (props.mode !== 'thread') return <CayeDirectThreadBase {...props} />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1, minWidth: 0, minHeight: 0 }}>
      <LiveWorkPanel threadId={props.threadId} />
      <div style={{ flex: 1, minHeight: 0 }}><CayeDirectThreadBase {...props} /></div>
    </div>
  )
}

type Run = {
  id: string
  status: 'queued' | 'planning' | 'running' | 'waiting_user' | 'paused'
  objective: string
  stage_label: string | null
  control_requested: 'pause' | 'cancel' | null
  started_at: string
}
type RunEvent = { id: number; kind: string; label: string; created_at: string }

function LiveWorkPanel({ threadId }: { threadId: string }) {
  const [run, setRun] = useState<Run | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [steer, setSteer] = useState('')
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
  }, [threadId])

  useEffect(() => {
    void load()
    const poll = window.setInterval(() => void load(), 1600)
    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { window.clearInterval(poll); window.clearInterval(clock) }
  }, [load])

  const elapsed = useMemo(() => {
    if (!run) return ''
    const seconds = Math.max(0, Math.floor((now - new Date(run.started_at).getTime()) / 1000))
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
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

  async function submitSteer() {
    if (!run || !steer.trim() || busy || run.status === 'paused') return
    setBusy(true)
    try {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch(`/api/founder/caye-direct/threads/${threadId}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ runId: run.id, message: steer.trim() }),
      })
      if (res.ok) { setSteer(''); await load() }
    } finally { setBusy(false) }
  }

  if (!run) return null
  const status = run.control_requested === 'pause' ? 'Pausing after this step'
    : run.control_requested === 'cancel' ? 'Stopping after this step'
    : run.status === 'waiting_user' ? 'Needs you'
    : run.status === 'paused' ? 'Paused'
    : run.status === 'queued' || run.status === 'planning' ? 'Starting' : 'Working'
  const controlsEnabled = ['queued','planning','running'].includes(run.status) && !run.control_requested

  return (
    <section aria-label="Key live work" style={{ margin: '10px max(20px, calc((100% - 720px) / 2)) 0', padding: '12px 14px', border: '1px solid rgba(78,190,206,.18)', borderRadius: 14, background: 'rgba(78,190,206,.045)', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: run.status === 'paused' || run.status === 'waiting_user' ? '#fbbf24' : '#4EBECE' }} />
        <strong style={{ fontSize: 12.5, color: '#e4e4e7' }}>{status}</strong>
        <span style={{ fontSize: 10, color: '#71717a', fontFamily: 'var(--font-mono)' }}>{elapsed}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button type="button" disabled={!controlsEnabled || busy} onClick={() => void control('pause')} style={buttonStyle}>Pause</button>
          <button type="button" disabled={!controlsEnabled || busy} onClick={() => void control('stop')} style={buttonStyle}>Stop</button>
        </div>
      </div>
      <div style={{ marginTop: 9 }}><Kicker>Goal</Kicker><div style={{ marginTop: 3, fontSize: 12.5, lineHeight: 1.45, color: '#c8c8ce' }}>{run.objective}</div></div>
      <div style={{ marginTop: 9 }}>
        <Kicker>Activity</Kicker>
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {events.slice(-5).map((item, index, list) => <div key={item.id} style={{ fontSize: 11.5, color: index === list.length - 1 ? '#d4d4d8' : '#85858d' }}>{index === list.length - 1 ? '●' : '✓'}&nbsp; {item.label}</div>)}
        </div>
      </div>
      {run.status === 'paused' ? (
        <div style={{ marginTop: 9, fontSize: 11, color: '#8e8e96' }}>Send a new message below to resume with new direction.</div>
      ) : (
        <div style={{ marginTop: 10, display: 'flex', gap: 7 }}>
          <input value={steer} onChange={(e) => setSteer(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submitSteer() }} placeholder="Steer Key…" style={{ flex: 1, minWidth: 0, border: '1px solid rgba(255,255,255,.09)', borderRadius: 8, background: 'rgba(255,255,255,.035)', color: '#e4e4e7', padding: '7px 9px', fontSize: 11.5, outline: 'none' }} />
          <button type="button" disabled={!steer.trim() || busy} onClick={() => void submitSteer()} style={buttonStyle}>Update</button>
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 10.5, color: '#686870' }}>Outputs and artifacts stay in the conversation below as Key creates them.</div>
    </section>
  )
}

function Kicker({ children }: { children: string }) { return <div style={{ color: '#66666f', fontSize: 9.5, fontFamily: 'var(--font-mono)', letterSpacing: '.08em', textTransform: 'uppercase' }}>{children}</div> }
const buttonStyle = { border: '1px solid rgba(255,255,255,.1)', background: 'rgba(255,255,255,.04)', color: '#a1a1aa', borderRadius: 7, padding: '4px 8px', fontSize: 10.5, cursor: 'pointer' }
