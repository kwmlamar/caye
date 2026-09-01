'use client'

import { useCallback, useEffect, useMemo, useState, type ComponentProps, type CSSProperties } from 'react'
import { getSession } from '@/lib/supabase'
import CayeDirectThreadBase from './CayeDirectThreadBase'

const WORK_PANEL_PREFERENCE_KEY = 'caye:direct:live-work-panel-open'

type Run = {
  id: string
  status: 'queued' | 'planning' | 'running' | 'waiting_user' | 'paused'
  objective: string
  stage_label: string | null
  control_requested: 'pause' | 'cancel' | null
  started_at: string
}
type RunEvent = { id: number; kind: string; label: string; created_at: string }

export default function CayeDirectThread(props: ComponentProps<typeof CayeDirectThreadBase>) {
  const [run, setRun] = useState<Run | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [preferenceHydrated, setPreferenceHydrated] = useState(false)
  const [hasExplicitPreference, setHasExplicitPreference] = useState(false)
  const [workPanelOpen, setWorkPanelOpen] = useState(false)
  const threadId = props.mode === 'thread' ? props.threadId : null

  const load = useCallback(async () => {
    if (!threadId) return
    const { session } = await getSession()
    if (!session) return
    const res = await fetch(`/api/founder/caye-direct/threads/${threadId}/run`, { headers: { Authorization: `Bearer ${session.access_token}` } })
    if (!res.ok) return
    const json = await res.json()
    setRun(json.run ?? null)
    setEvents(json.events ?? [])
  }, [threadId])

  useEffect(() => {
    if (!threadId) return
    try {
      const stored = window.localStorage.getItem(WORK_PANEL_PREFERENCE_KEY)
      if (stored === 'true' || stored === 'false') {
        setWorkPanelOpen(stored === 'true')
        setHasExplicitPreference(true)
      }
    } catch {
      // Storage can be unavailable in locked-down browsers. The in-memory default remains safe.
    }
    setPreferenceHydrated(true)
  }, [threadId])

  useEffect(() => {
    if (!threadId) return
    void load()
    const poll = window.setInterval(() => void load(), 1600)
    return () => window.clearInterval(poll)
  }, [load, threadId])

  useEffect(() => {
    if (!preferenceHydrated || hasExplicitPreference || !run) return
    setWorkPanelOpen(true)
  }, [preferenceHydrated, hasExplicitPreference, run])

  const toggleWorkPanel = useCallback(() => {
    setWorkPanelOpen((value) => {
      const next = !value
      try { window.localStorage.setItem(WORK_PANEL_PREFERENCE_KEY, String(next)) } catch { /* keep in-memory preference */ }
      return next
    })
    setHasExplicitPreference(true)
  }, [])

  if (props.mode !== 'thread') return <CayeDirectThreadBase {...props} />
  const hasActiveWork = Boolean(run)

  return (
    <div style={{ position: 'relative', display: 'flex', height: '100%', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}><CayeDirectThreadBase {...props} /></div>
      {hasActiveWork && preferenceHydrated ? <WorkPanelToggle open={workPanelOpen} onClick={toggleWorkPanel} /> : null}
      {hasActiveWork && workPanelOpen ? <LiveWorkRail threadId={threadId!} run={run!} events={events} reload={load} /> : null}
    </div>
  )
}

function useCompactWorkRail() {
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 980px)')
    const sync = () => setCompact(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])
  return compact
}

function WorkPanelToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-label={open ? 'Close work panel' : 'Open work panel'} title={open ? 'Close work panel' : 'Open work panel'} onClick={onClick}
      style={{ position: 'absolute', zIndex: 60, top: 13, right: 13, width: 32, height: 32, display: 'grid', placeItems: 'center', border: 0, padding: 0, borderRadius: 8, background: 'transparent', color: open ? '#dedee1' : '#9a9ba1', cursor: 'pointer' }}>
      <span aria-hidden style={{ position: 'relative', display: 'block', width: 16, height: 14, border: '1.5px solid currentColor', borderRadius: 4, boxSizing: 'border-box' }}>
        <span style={{ position: 'absolute', top: 0, bottom: 0, right: 4, width: 1, background: 'currentColor', opacity: .72 }} />
        <span style={{ position: 'absolute', top: 2.5, right: 1.5, width: 1.5, height: 7, borderRadius: 2, background: open ? '#55c7d8' : 'currentColor', opacity: open ? 1 : .55 }} />
      </span>
    </button>
  )
}

function LiveWorkRail({ threadId, run, events, reload }: { threadId: string; run: Run; events: RunEvent[]; reload: () => Promise<void> }) {
  const [steer, setSteer] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  const compact = useCompactWorkRail()

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(clock)
  }, [])

  const elapsed = useMemo(() => {
    const seconds = Math.max(0, Math.floor((now - new Date(run.started_at).getTime()) / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  }, [run.started_at, now])

  async function control(action: 'pause' | 'stop') {
    if (busy) return
    setBusy(true)
    try {
      const { session } = await getSession()
      if (!session) return
      await fetch(`/api/founder/caye-direct/threads/${threadId}/run`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ runId: run.id, action }),
      })
      await reload()
    } finally { setBusy(false) }
  }

  async function submitSteer() {
    if (!steer.trim() || busy || run.status === 'paused') return
    setBusy(true)
    try {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch(`/api/founder/caye-direct/threads/${threadId}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ runId: run.id, message: steer.trim() }),
      })
      if (res.ok) { setSteer(''); await reload() }
    } finally { setBusy(false) }
  }

  const shell: CSSProperties = compact
    ? { position: 'absolute', zIndex: 30, left: 12, right: 12, bottom: 12, maxHeight: '62%', border: '1px solid rgba(255,255,255,.10)', borderRadius: 18, boxShadow: '0 20px 65px rgba(0,0,0,.48)' }
    : { width: 'clamp(350px, 29vw, 420px)', minWidth: 350, height: '100%', flexShrink: 0, borderLeft: '1px solid rgba(255,255,255,.075)' }
  const status = run.control_requested === 'pause' ? 'Pausing after this step'
    : run.control_requested === 'cancel' ? 'Stopping after this step'
    : run.status === 'waiting_user' ? 'Needs you'
    : run.status === 'paused' ? 'Paused'
    : run.status === 'queued' || run.status === 'planning' ? 'Starting' : (run.stage_label || 'Working')
  const controlsEnabled = ['queued', 'planning', 'running'].includes(run.status) && !run.control_requested
  const latestEvents = events.slice(-7)
  const attention = run.status === 'paused' || run.status === 'waiting_user'

  return (
    <aside aria-label="Caye live work" style={{ ...shell, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', background: 'rgba(13,13,14,.985)', backdropFilter: 'blur(18px)' }}>
      <div style={{ padding: compact ? '16px 56px 12px 16px' : '22px 58px 16px 20px', borderBottom: '1px solid rgba(255,255,255,.055)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: attention ? '#f3ba63' : '#55c7d8' }} />
          <div style={{ fontSize: 13, fontWeight: 650, color: '#f1f1f3' }}>Caye is working</div>
          <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#69696f', fontFamily: 'var(--font-mono)' }}>{elapsed}</span>
        </div>
        <div style={{ marginTop: 13, fontSize: 10.5, color: attention ? '#d8b879' : '#9fa0a6' }}>{status}</div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: compact ? '14px 16px' : '18px 20px 20px' }}>
        <SectionLabel>Task</SectionLabel>
        <div style={{ marginTop: 8, padding: '12px 13px', borderRadius: 12, background: 'rgba(255,255,255,.028)', border: '1px solid rgba(255,255,255,.055)', color: '#c9c9ce', fontSize: 12.5, lineHeight: 1.55 }}>{run.objective}</div>
        <div style={{ marginTop: 22 }}><SectionLabel>Activity</SectionLabel>
          <div style={{ marginTop: 12 }}>{latestEvents.length ? latestEvents.map((item, index) => (
            <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '12px minmax(0,1fr)', gap: 8, paddingBottom: index === latestEvents.length - 1 ? 0 : 14 }}>
              <span aria-hidden style={{ width: 7, height: 7, marginTop: 4, borderRadius: '50%', background: index === latestEvents.length - 1 ? '#55c7d8' : '#47484d' }} />
              <div><div style={{ fontSize: 12, lineHeight: 1.42, color: index === latestEvents.length - 1 ? '#dedee1' : '#8a8b91' }}>{item.label}</div><div style={{ marginTop: 3, fontSize: 9.5, color: '#56575d' }}>{formatEventTime(item.created_at)}</div></div>
            </div>
          )) : <div style={{ fontSize: 12, color: '#72737a' }}>Preparing the first step…</div>}</div>
        </div>
      </div>
      <div style={{ padding: compact ? '12px 16px 16px' : '14px 20px 18px', borderTop: '1px solid rgba(255,255,255,.06)' }}>
        {run.status === 'paused' ? <div style={{ fontSize: 11.5, color: '#b8a27e' }}>Paused safely. Send a new message in the conversation to resume with new direction.</div> : <>
          <SectionLabel>Guide the work</SectionLabel>
          <div style={{ marginTop: 8, display: 'flex', gap: 7 }}><textarea value={steer} onChange={(e) => setSteer(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitSteer() } }} placeholder="Add context or change direction…" rows={2} style={{ flex: 1, resize: 'none', border: '1px solid rgba(255,255,255,.085)', borderRadius: 11, background: 'rgba(255,255,255,.028)', color: '#e5e5e7', padding: '9px 10px', fontSize: 11.5 }} /><button type="button" disabled={!steer.trim() || busy} onClick={() => void submitSteer()} style={actionButton}>Send</button></div>
        </>}
        <div style={{ marginTop: 11, display: 'flex', gap: 7 }}><button type="button" disabled={!controlsEnabled || busy} onClick={() => void control('pause')} style={actionButton}>Pause</button><button type="button" disabled={!controlsEnabled || busy} onClick={() => void control('stop')} style={actionButton}>Stop</button><span style={{ marginLeft: 'auto', fontSize: 9.5, color: '#525359' }}>Results appear in chat</span></div>
      </div>
    </aside>
  )
}

function SectionLabel({ children }: { children: string }) {
  return <div style={{ color: '#65666c', fontSize: 9.5, fontWeight: 600, letterSpacing: '.09em', textTransform: 'uppercase' }}>{children}</div>
}
function formatEventTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
const actionButton: CSSProperties = { border: '1px solid rgba(255,255,255,.08)', background: 'rgba(255,255,255,.025)', color: '#898a90', borderRadius: 9, padding: '6px 10px', fontSize: 10.5, cursor: 'pointer', fontFamily: 'inherit' }
