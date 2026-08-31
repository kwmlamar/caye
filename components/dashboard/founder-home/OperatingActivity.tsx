'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getSession } from '@/lib/supabase'
import { AQUA, EMERALD, GOLD, ROSE, TEXT, TEXT_MUTED, TEXT_QUIET, glass } from '../surface'

type Tone = 'neutral' | 'good' | 'warn' | 'attention'
type ActivityItem = { label: string; detail?: string | null; at?: string | null; tone?: Tone }
type OperatingActivityData = {
  status: 'working' | 'scheduled' | 'idle'
  generatedAt: string
  lastActivityAt: string | null
  sections: {
    researchingNow: ActivityItem[]
    recentlyLearned: ActivityItem[]
    beliefChanges: ActivityItem[]
    actionsTaken: ActivityItem[]
    waitingOnHuman: ActivityItem[]
    nextScheduledWork: ActivityItem[]
  }
}

const TONE_COLOR: Record<Tone, string> = { neutral: TEXT_QUIET, good: EMERALD, warn: GOLD, attention: ROSE }
const STATUS = {
  working: { label: 'WORKING NOW', color: EMERALD },
  scheduled: { label: 'SCHEDULED', color: AQUA },
  idle: { label: 'IDLE', color: TEXT_QUIET },
} as const

function relativeTime(value: string | null | undefined): string | null {
  if (!value) return null
  const when = new Date(value).getTime()
  if (!Number.isFinite(when)) return null
  const delta = when - Date.now()
  const abs = Math.abs(delta)
  if (abs < 60_000) return delta >= 0 ? 'in <1m' : 'just now'
  const minutes = Math.round(abs / 60_000)
  if (minutes < 60) return delta >= 0 ? `in ${minutes}m` : `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return delta >= 0 ? `in ${hours}h` : `${hours}h ago`
  const days = Math.round(hours / 24)
  return delta >= 0 ? `in ${days}d` : `${days}d ago`
}

function ActivityCard({ title, items, empty, future = false }: { title: string; items: ActivityItem[]; empty: string; future?: boolean }) {
  return (
    <div style={{ ...glass(0.035), borderRadius: 12, padding: '12px 13px', minHeight: 112 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.045em', color: TEXT_QUIET, marginBottom: 9 }}>{title.toUpperCase()}</div>
      {items.length === 0 ? (
        <div style={{ fontSize: 11.5, lineHeight: 1.45, color: TEXT_QUIET }}>{empty}</div>
      ) : (
        <div style={{ display: 'grid', gap: 9 }}>
          {items.slice(0, 3).map((item, index) => (
            <div key={`${item.label}-${index}`} style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start' }}>
                <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, marginTop: 5, background: TONE_COLOR[item.tone ?? 'neutral'], boxShadow: item.tone === 'good' ? `0 0 6px ${EMERALD}88` : undefined }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11.5, lineHeight: 1.4, color: TEXT }}>{item.label}</div>
                  {item.detail && <div style={{ fontSize: 10.5, lineHeight: 1.4, color: TEXT_MUTED, marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{item.detail}</div>}
                  {item.at && <div style={{ fontSize: 9.5, color: TEXT_QUIET, marginTop: 3 }}>{relativeTime(item.at)}{future ? ' · scheduled' : ''}</div>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function OperatingActivity({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<OperatingActivityData | null>(null)
  const [failed, setFailed] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true)
    try {
      const { session } = await getSession()
      if (!session) return
      const response = await fetch(`/api/founder/operating-activity?workspaceId=${encodeURIComponent(workspaceId)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`Operating activity request failed (${response.status})`)
      setData(await response.json())
      setFailed(false)
    } catch (error) {
      console.error('[OperatingActivity] load failed', error)
      setFailed(true)
    } finally {
      if (!quiet) setRefreshing(false)
    }
  }, [workspaceId])

  useEffect(() => {
    load()
    const timer = window.setInterval(() => load(true), 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  const state = STATUS[data?.status ?? 'idle']
  const counts = useMemo(() => data ? Object.values(data.sections).reduce((sum, items) => sum + items.length, 0) : 0, [data])

  return (
    <section style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.055em', color: TEXT_QUIET }}>LIVE OPERATING ACTIVITY</div>
          <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 4 }}>What Caye is doing, learning, changing, and waiting on without requiring a chat prompt.</div>
        </div>
        <button type="button" onClick={() => load()} disabled={refreshing} style={{ border: 0, background: 'transparent', padding: 0, color: state.color, cursor: refreshing ? 'default' : 'pointer', font: '700 10.5px inherit', whiteSpace: 'nowrap', opacity: refreshing ? 0.55 : 1 }}>
          <span aria-hidden style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', marginRight: 6, background: failed ? ROSE : state.color, boxShadow: data?.status === 'working' ? `0 0 7px ${EMERALD}99` : undefined }} />
          {failed ? 'ACTIVITY UNAVAILABLE' : refreshing && !data ? 'CHECKING…' : state.label}
        </button>
      </div>

      {failed && !data ? (
        <div style={{ ...glass(0.035), borderRadius: 12, padding: '13px 14px', fontSize: 11.5, color: ROSE }}>Live activity could not be read. The panel will retry automatically.</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
            <ActivityCard title="Researching now" items={data?.sections.researchingNow ?? []} empty="No investigation is running right now." />
            <ActivityCard title="Recently learned" items={data?.sections.recentlyLearned ?? []} empty="No durable intelligence has been recorded yet." />
            <ActivityCard title="Beliefs changed" items={data?.sections.beliefChanges ?? []} empty="No explicit contradiction or supersession has been recorded yet." />
            <ActivityCard title="Actions taken" items={data?.sections.actionsTaken ?? []} empty="No recently verified action for this workspace." />
            <ActivityCard title="Waiting on human" items={data?.sections.waitingOnHuman ?? []} empty="Nothing in this workspace currently needs a human decision." />
            <ActivityCard title="Next scheduled work" items={data?.sections.nextScheduledWork ?? []} empty="No autonomous research work is currently scheduled." future />
          </div>
          <div style={{ marginTop: 7, display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 9.5, color: TEXT_QUIET }}>
            <span>{counts} live signal{counts === 1 ? '' : 's'} shown</span>
            <span>{data?.lastActivityAt ? `last activity ${relativeTime(data.lastActivityAt)}` : 'no recorded activity yet'} · refreshes every 30s</span>
          </div>
        </>
      )}
    </section>
  )
}
