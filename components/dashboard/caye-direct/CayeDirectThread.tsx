'use client'

import { useCallback, useEffect, useMemo, useState, type ComponentProps, type CSSProperties } from 'react'
import { getSession } from '@/lib/supabase'
import CayeDirectThreadBase from './CayeDirectThreadBase'

export default function CayeDirectThread(props: ComponentProps<typeof CayeDirectThreadBase>) {
  const [workPanelOpen, setWorkPanelOpen] = useState(true)
  if (props.mode !== 'thread') return <CayeDirectThreadBase {...props} />
  return (
    <div style={{ position: 'relative', display: 'flex', height: '100%', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}><CayeDirectThreadBase {...props} /></div>
      <WorkPanelToggle open={workPanelOpen} onClick={() => setWorkPanelOpen((value) => !value)} />
      <LiveWorkRail threadId={props.threadId} open={workPanelOpen} />
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
    <button
      type="button"
      aria-label={open ? 'Close work panel' : 'Open work panel'}
      title={open ? 'Close work panel' : 'Open work panel'}
      onClick={onClick}
      style={{
        position: 'absolute', zIndex: 60, top: 12, right: 12, width: 34, height: 34,
        display: 'grid', placeItems: 'center', borderRadius: 10,
        border: '1px solid rgba(255,255,255,.085)',
        background: open ? 'rgba(255,255,255,.055)' : 'rgba(18,18,19,.88)',
        color: open ? '#e4e4e7' : '#a2a2a8',
        boxShadow: '0 8px 24px rgba(0,0,0,.18)', backdropFilter: 'blur(14px)',
        cursor: 'pointer', transition: 'background 140ms ease, color 140ms ease, border-color 140ms ease',
      }}
    >
      <span aria-hidden style={{ position: 'relative', display: 'block', width: 16, height: 14, border: '1.5px solid currentColor', borderRadius: 4, boxSizing: 'border-box' }}>
        <span style={{ position: 'absolute', top: 0, bottom: 0, right: 4, width: 1, background: 'currentColor', opacity: .72 }} />
        <span style={{ position: 'absolute', top: 2.5, right: 1.5, width: 1.5, height: 7, borderRadius: 2, background: open ? '#55c7d8' : 'currentColor', opacity: open ? 1 : .55 }} />
      </span>
    </button>
  )
}

function LiveWorkRail({ threadId, open }: { threadId: string; open: boolean }) {
  const [run, setRun] = useState<Run | null>(null)
  const [events, setEvents] = useState<RunEvent[]>([])
  const [steer, setSteer] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  const compact = useCompactWorkRail()

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
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
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

  if (!run || !open) return null

  const status = run.control_requested === 'pause' ? 'Pausing after this step'
    : run.control_requested === 'cancel' ? 'Stopping after this step'
    : run.status === 'waiting_user' ? 'Needs you'
    : run.status === 'paused' ? 'Paused'
    : run.status === 'queued' || run.status === 'planning' ? 'Starting' : (run.stage_label || 'Working')
  const controlsEnabled = ['queued','planning','running'].includes(run.status) && !run.control_requested
  const latestEvents = events.slice(-7)
  const attention = run.status === 'paused' || run.status === 'waiting_user'

  const shell: CSSProperties = compact ? {
    position: 'absolute', zIndex: 30, left: 12, right: 12, bottom: 12, maxHeight: '62%',
    border: '1px solid rgba(255,255,255,.10)', borderRadius: 18, boxShadow: '0 20px 65px rgba(0,0,0,.48)',
  } : {
    width: 'clamp(350px, 29vw, 420px)', minWidth: 350, height: '100%', flexShrink: 0,
    borderLeft: '1px solid rgba(255,255,255,.075)',
  }

  return (
    <aside aria-label="Key live work" style={{ ...shell, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', background: 'rgba(13,13,14,.985)', backdropFilter: 'blur(18px)' }}>
      <div style={{ padding: compact ? '16px 56px 12px 16px' : '22px 58px 16px 20px', borderBottom: '1px solid rgba(255,255,255,.055)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: attention ? '#f3ba63' : '#55c7d8', boxShadow: attention ? '0 0 0 4px rgba(243,186,99,.08)' : '0 0 0 4px rgba(85,199,216,.08)' }} />
          <div style={{ fontSize: 13, fontWeight: 650, color: '#f1f1f3', letterSpacing: '-.01em' }}>Key is working</div>
          <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#69696f', fontFamily: 'var(--font-mono)' }}>{elapsed}</span>
        </div>
        <div style={{ marginTop: 13, display: 'inline-flex', alignItems: 'center', maxWidth: '100%', border: '1px solid rgba(255,255,255,.07)', borderRadius: 999, padding: '5px 9px', background: 'rgba(255,255,255,.025)', fontSize: 10.5, color: attention ? '#d8b879' : '#9fa0a6' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status}</span>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: compact ? '14px 16px' : '18px 20px 20px' }}>
        <SectionLabel>Task</SectionLabel>
        <div style={{ marginTop: 8, padding: '12px 13px', borderRadius: 12, background: 'rgba(255,255,255,.028)', border: '1px solid rgba(255,255,255,.055)', color: '#c9c9ce', fontSize: 12.5, lineHeight: 1.55 }}>
          {run.objective}
        </div>

        <div style={{ marginTop: 22 }}>
          <SectionLabel>Activity</SectionLabel>
          <div style={{ marginTop: 12 }}>
            {latestEvents.length ? latestEvents.map((item, index) => {
              const last = index === latestEvents.length - 1
              return (
                <div key={item.id} style={{ position: 'relative', display: 'grid', gridTemplateColumns: '16px minmax(0,1fr)', gap: 8, paddingBottom: index === latestEvents.length - 1 ? 0 : 14 }}>
                  {index < latestEvents.length - 1 && <span aria-hidden style={{ position: 'absolute', left: 4, top: 11, bottom: -2, width: 1, background: 'rgba(255,255,255,.07)' }} />}
                  <span aria-hidden style={{ width: last ? 9 : 7, height: last ? 9 : 7, marginTop: 4, borderRadius: '50%', background: last ? '#55c7d8' : '#47484d', boxShadow: last ? '0 0 0 4px rgba(85,199,216,.07)' : undefined }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, lineHeight: 1.42, color: last ? '#dedee1' : '#8a8b91' }}>{item.label}</div>
                    <div style={{ marginTop: 3, fontSize: 9.5, color: '#56575d', fontFamily: 'var(--font-mono)' }}>{formatEventTime(item.created_at)}</div>
                  </div>
                </div>
              )
            }) : <div style={{ fontSize: 12, color: '#72737a' }}>Preparing the first step…</div>}
          </div>
        </div>
      </div>

      <div style={{ padding: compact ? '12px 16px 16px' : '14px 20px 18px', borderTop: '1px solid rgba(255,255,255,.06)', background: 'rgba(255,255,255,.012)' }}>
        {run.status === 'paused' ? (
          <div style={{ padding: '10px 11px', borderRadius: 10, background: 'rgba(243,186,99,.055)', border: '1px solid rgba(243,186,99,.12)', fontSize: 11.5, lineHeight: 1.45, color: '#b8a27e' }}>Paused safely. Send a new message in the conversation to resume with new direction.</div>
        ) : (
          <>
            <SectionLabel>Guide the work</SectionLabel>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'flex-end', gap: 7 }}>
              <textarea
                value={steer}
                onChange={(e) => setSteer(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submitSteer() } }}
                placeholder="Add context or change direction…"
                rows={2}
                style={{ flex: 1, minWidth: 0, resize: 'none', border: '1px solid rgba(255,255,255,.085)', borderRadius: 11, background: 'rgba(255,255,255,.028)', color: '#e5e5e7', padding: '9px 10px', fontSize: 11.5, lineHeight: 1.45, outline: 'none', fontFamily: 'inherit' }}
              />
              <button type="button" disabled={!steer.trim() || busy} onClick={() => void submitSteer()} style={{ ...actionButton, height: 34, padding: '0 11px', color: steer.trim() && !busy ? '#d8f2f5' : '#66676c', borderColor: steer.trim() && !busy ? 'rgba(85,199,216,.22)' : 'rgba(255,255,255,.07)', background: steer.trim() && !busy ? 'rgba(85,199,216,.085)' : 'rgba(255,255,255,.025)' }}>Send</button>
            </div>
          </>
        )}
        <div style={{ marginTop: 11, display: 'flex', alignItems: 'center', gap: 7 }}>
          <button type="button" disabled={!controlsEnabled || busy} onClick={() => void control('pause')} style={actionButton}>Pause</button>
          <button type="button" disabled={!controlsEnabled || busy} onClick={() => void control('stop')} style={{ ...actionButton, color: controlsEnabled && !busy ? '#a8a8ad' : '#5c5d61' }}>Stop</button>
          <span style={{ marginLeft: 'auto', fontSize: 9.5, color: '#525359' }}>Results appear in chat</span>
        </div>
      </div>
    </aside>
  )
}

function SectionLabel({ children }: { children: string }) {
  return <div style={{ color: '#65666c', fontSize: 9.5, fontWeight: 600, letterSpacing: '.09em', textTransform: 'uppercase' }}>{children}</div>
}

function formatEventTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

const actionButton: CSSProperties = {
  border: '1px solid rgba(255,255,255,.08)', background: 'rgba(255,255,255,.025)', color: '#898a90',
  borderRadius: 9, padding: '6px 10px', fontSize: 10.5, cursor: 'pointer', fontFamily: 'inherit',
}
