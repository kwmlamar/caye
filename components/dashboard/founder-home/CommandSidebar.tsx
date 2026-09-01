'use client'

import { createPortal } from 'react-dom'
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { getSession } from '@/lib/supabase'
import CommandSidebarBase from './CommandSidebarBase'

export type { ActiveView, ThreadListItem, LiveOperator } from './CommandSidebarBase'

type Props = ComponentProps<typeof CommandSidebarBase>
type Run = { id: string; thread_id: string; status: 'queued' | 'planning' | 'running' | 'waiting_user' | 'paused'; label: string; started_at: string }

export default function CommandSidebar(props: Props) {
  const [runs, setRuns] = useState<Run[]>([])
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { session } = await getSession()
      if (!session) return
      const res = await fetch(`/api/founder/caye-direct/runs?workspaceId=${encodeURIComponent(props.activeWorkspaceId)}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      if (!res.ok) return
      const json = await res.json()
      if (!cancelled) setRuns(Array.isArray(json.runs) ? json.runs : [])
    }
    void load()
    const timer = window.setInterval(() => void load(), 2200)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [props.activeWorkspaceId])

  useEffect(() => {
    const root = rootRef.current
    const scroll = root?.querySelector('nav[aria-label="Caye Command navigation"] > div > div:nth-child(4)')
    if (!(scroll instanceof HTMLElement)) { setPortalHost(null); return }
    const host = document.createElement('div')
    host.dataset.keyWorkingThreads = 'true'
    scroll.prepend(host)
    setPortalHost(host)
    return () => { setPortalHost(null); host.remove() }
  }, [props.collapsed])

  const runByThread = useMemo(() => new Map(runs.map((run) => [run.thread_id, run])), [runs])
  const working = useMemo(() => (props.threads ?? []).flatMap((thread) => {
    const run = runByThread.get(thread.id)
    return run ? [{ thread, run }] : []
  }).sort((a, b) => {
    const priority = (s: Run['status']) => s === 'waiting_user' || s === 'paused' ? 0 : 1
    return priority(a.run.status) - priority(b.run.status) || new Date(b.run.started_at).getTime() - new Date(a.run.started_at).getTime()
  }), [props.threads, runByThread])

  const filteredThreads = props.threads === null ? null : props.threads.filter((thread) => !runByThread.has(thread.id))

  return (
    <div ref={rootRef} style={{ display: 'contents' }}>
      <CommandSidebarBase {...props} threads={filteredThreads} />
      {portalHost && working.length > 0 && createPortal(
        <div style={{ padding: '0 3px 1px' }}>
          <div style={{ padding: '9px 8px 4px', color: '#5c5c64', fontSize: 10, fontWeight: 600, letterSpacing: '.025em' }}>Working</div>
          {working.map(({ thread, run }) => {
            const active = props.activeView.type === 'thread' && props.activeView.id === thread.id
            const needs = run.status === 'waiting_user' || run.status === 'paused'
            return (
              <button key={thread.id} type="button" onClick={() => props.onSelectThread(thread.id)} style={{ width: '100%', minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: 7, padding: '6px 8px', border: 0, borderRadius: 8, background: active ? 'rgba(78,190,206,.11)' : 'transparent', color: active ? '#f4f4f5' : '#b1b1b9', cursor: 'pointer', textAlign: 'left' }}>
                <span aria-hidden style={{ width: 6, height: 6, marginTop: 4, flex: '0 0 6px', borderRadius: '50%', background: needs ? '#fbbf24' : '#4EBECE' }} />
                <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span style={{ maxWidth: 175, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 500 }}>{thread.title || 'New conversation'}</span>
                  <span style={{ maxWidth: 175, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: needs ? '#d9ae57' : '#6f9ea5', fontSize: 9.5 }}>{run.label}</span>
                </span>
              </button>
            )
          })}
        </div>, portalHost
      )}
    </div>
  )
}
