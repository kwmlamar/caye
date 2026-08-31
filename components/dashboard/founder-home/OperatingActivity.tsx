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
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? items : items.slice(0, 3)
  const canExpand = items.length > 0 && (items.length > 3 || items.some((item) => Boolean(item.detail)))

  return (
    <div style={{ ...glass(0.035), borderRadius: 12, padding: '12px 13px', minHeight: 112 }}>
      <button
        type="button"
        onClick={() => canExpand && setExpanded((value) => !value)}
        aria-expanded={canExpand ? expanded : undefined}
        style={{ width: '100%', border: 0, background: 'transparent', padding: 0, color: TEXT, textAlign: 'left', cursor: canExpand ? 'pointer' : 'default' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 9 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.045em', color: TEXT_QUIET }}>{title.toUpperCase()}</div>
          {canExpand && <span aria-hidden style={{ color: TEXT_QUIET, fontSize: 11 }}>{expanded ? '▾' : '▸'}</span>}
        </div>
      </button>

      {items.length === 0 ? (
        <div style={{ fontSize: 11.5, lineHeight: 1.45, color: TEXT_QUIET }}>{empty}</div>
      ) : (
        <div style={{ display: 'grid', gap: 9 }}>
          {shown.map((item, index) => (
            <button
              type="button"
              key={`${item.label}-${index}`}
              onClick={() => canExpand && setExpanded(true)}
              style={{ minWidth: 0, width: '100%', border: 0, background: 'transparent', padding: 0, textAlign: 'left', color: TEXT, cursor: item.detail && !expanded ? 'pointer' : 'default' }}
            >
              <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start' }}>
                <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, marginTop: 5, background: TONE_COLOR[item.tone ?? 'neutral'], boxShadow: item.tone === 'good' ? `0 0 6px ${EMERALD}88` : undefined }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11.5, lineHeight: 1.4, color: TEXT }}>{item.label}</div>
                  {item.detail && (
                    <div style={expanded
                      ? { fontSize: 10.5, lineHeight: 1.5, color: TEXT_MUTED, marginTop: 4, whiteSpace: 'pre-wrap' }
                      : { fontSize: 10.5, lineHeight: 1.4, color: TEXT_MUTED, marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                    >
                      {item.detail}
                    </div>
                  )}
                  {item.at && <div style={{ fontSize: 9.5, color: TEXT_QUIET, marginTop: 3 }}>{relativeTime(item.at)}{future ? ' · scheduled' : ''}</div>}
                </div>
              </div>
            </button>
          ))}
          {canExpand && !expanded && <div style={{ fontSize: 9.5, color: TEXT_QUIET, paddingLeft: 13 }}>Click to read more</div>}
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
          <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 4 }}>What Caye is doing, learning, changing, and waiting on.</div>
        </div>
        <button type="button" onClick={() => load()} disabled={refreshing} style={{ border: 0, background: 'transparent', padding: 0, color: state.color, cursor: refreshing ? 'default' : 'pointer', font: '700 10.5px inherit', whiteSpace: 'nowrap', opacity: refreshing ? 0.55 : 1 }}>
          <span aria-hidden style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', marginRight: 6, background: failed ? ROSE : state.color, boxShadow: data?.status === 'working' ? `0 0 7px ${EMERALD}99` : undefined }} />
          {failed ? 'ACTIVITY UNAVAILABLE' : refreshing && !data ? 'CHECKING…' : state.label}
        </button>
      </div>

      {failed && !data ? (
        <div style={{ ...glass(0.035), borderRadius: 12, padding: '13px 14px', fontSize: 11.5, color: ROSE }}>I could not load live activity. I will keep trying.</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
            <ActivityCard title="Researching now" items={data?.sections.researchingNow ?? []} empty="Nothing is being researched right now." />
            <ActivityCard title="Recently learned" items={data?.sections.recentlyLearned ?? []} empty="Nothing new has been saved yet." />
            <ActivityCard title="Beliefs changed" items={data?.sections.beliefChanges ?? []} empty="Nothing has changed my mind yet." />
            <ActivityCard title="Actions taken" items={data?.sections.actionsTaken ?? []} empty="No recent action has been verified." />
            <ActivityCard title="Waiting on human" items={data?.sections.waitingOnHuman ?? []} empty="Nothing needs a human decision right now." />
            <ActivityCard title="Next scheduled work" items={data?.sections.nextScheduledWork ?? []} empty="No research is scheduled right now." future />
          </div>
          <div style={{ marginTop: 7, display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 9.5, color: TEXT_QUIET }}>
            <span>{counts} live item{counts === 1 ? '' : 's'}</span>
            <span>{data?.lastActivityAt ? `last activity ${relativeTime(data.lastActivityAt)}` : 'no activity yet'} · refreshes every 30s</span>
          </div>
        </>
      )}
    </section>
  )
}
