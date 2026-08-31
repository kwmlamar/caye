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
  sectionTotals?: { recentlyLearned?: number }
  sections: {
    researchingNow: ActivityItem[]
    recentlyLearned: ActivityItem[]
    beliefChanges: ActivityItem[]
    actionsTaken: ActivityItem[]
    waitingOnHuman: ActivityItem[]
    nextScheduledWork: ActivityItem[]
  }
}

type SectionKey = keyof OperatingActivityData['sections']
type SectionConfig = { key: SectionKey; title: string; shortTitle: string; empty: string; color: string; future?: boolean }

const TONE_COLOR: Record<Tone, string> = { neutral: TEXT_QUIET, good: EMERALD, warn: GOLD, attention: ROSE }
const STATUS = {
  working: { label: 'Working now', color: EMERALD },
  scheduled: { label: 'Next work scheduled', color: AQUA },
  idle: { label: 'Nothing scheduled', color: TEXT_QUIET },
} as const
const SECTIONS: SectionConfig[] = [
  { key: 'researchingNow', title: 'Researching now', shortTitle: 'Researching', empty: 'Nothing is being researched right now.', color: AQUA },
  { key: 'recentlyLearned', title: 'Recently learned', shortTitle: 'Learned', empty: 'Nothing new has been saved yet.', color: EMERALD },
  { key: 'beliefChanges', title: 'Changed my mind', shortTitle: 'Changed', empty: 'Nothing has changed my mind yet.', color: GOLD },
  { key: 'actionsTaken', title: 'Actions taken', shortTitle: 'Done', empty: 'No recent action has been verified.', color: EMERALD },
  { key: 'waitingOnHuman', title: 'Needs you', shortTitle: 'Needs you', empty: 'Nothing needs your decision right now.', color: ROSE },
  { key: 'nextScheduledWork', title: 'Up next', shortTitle: 'Up next', empty: 'No research is scheduled right now.', color: AQUA, future: true },
]

function relativeTime(value: string | null | undefined): string | null {
  if (!value) return null
  const when = new Date(value).getTime()
  if (!Number.isFinite(when)) return null
  const delta = when - Date.now(); const abs = Math.abs(delta)
  if (abs < 60_000) return delta >= 0 ? 'in <1m' : 'just now'
  const minutes = Math.round(abs / 60_000)
  if (minutes < 60) return delta >= 0 ? `in ${minutes}m` : `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return delta >= 0 ? `in ${hours}h` : `${hours}h ago`
  const days = Math.round(hours / 24)
  return delta >= 0 ? `in ${days}d` : `${days}d ago`
}

function ActivityRow({ item, color, future, onOpen }: { item: ActivityItem; color: string; future?: boolean; onOpen: () => void }) {
  return <button type="button" onClick={onOpen} style={{ width: '100%', display: 'grid', gridTemplateColumns: '7px minmax(0, 1fr) auto', alignItems: 'start', gap: 10, border: 0, borderBottom: '1px solid rgba(255,255,255,0.055)', background: 'transparent', padding: '12px 2px', color: TEXT, textAlign: 'left', cursor: 'pointer' }}>
    <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', marginTop: 5, background: TONE_COLOR[item.tone ?? 'neutral'] || color }} />
    <span style={{ minWidth: 0 }}><span style={{ display: 'block', fontSize: 12, lineHeight: 1.45, color: TEXT }}>{item.label}</span>{item.detail && <span style={{ display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden', marginTop: 3, fontSize: 10.5, lineHeight: 1.4, color: TEXT_MUTED }}>{item.detail}</span>}</span>
    <span style={{ paddingLeft: 8, whiteSpace: 'nowrap', fontSize: 9.5, color: TEXT_QUIET }}>{item.at ? `${relativeTime(item.at)}${future ? ' · scheduled' : ''}` : '›'}</span>
  </button>
}

function ActivityDetail({ section, item, onClose }: { section: SectionConfig; item: ActivityItem; onClose: () => void }) {
  return <div role="dialog" aria-modal="true" aria-label={section.title} onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'rgba(0,0,0,0.64)', backdropFilter: 'blur(8px)' }}>
    <div onClick={(event) => event.stopPropagation()} style={{ ...glass(0.07), width: 'min(680px, 100%)', maxHeight: '78vh', overflowY: 'auto', borderRadius: 18, padding: '22px 24px 24px', boxShadow: '0 24px 80px rgba(0,0,0,0.45)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 18 }}><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: section.color }} /><span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.045em', color: TEXT_MUTED }}>{section.title.toUpperCase()}</span></div><button type="button" onClick={onClose} aria-label="Close" style={{ border: 0, background: 'transparent', color: TEXT_QUIET, cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>×</button></div>
      <div style={{ fontSize: 17, lineHeight: 1.45, fontWeight: 550, color: TEXT }}>{item.label}</div>{item.detail && <div style={{ marginTop: 14, whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.65, color: TEXT_MUTED }}>{item.detail}</div>}{item.at && <div style={{ marginTop: 18, fontSize: 10.5, color: TEXT_QUIET }}>{relativeTime(item.at)}{section.future ? ' · scheduled' : ''}</div>}
    </div>
  </div>
}

export default function OperatingActivity({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<OperatingActivityData | null>(null); const [failed, setFailed] = useState(false); const [refreshing, setRefreshing] = useState(false)
  const [activeSection, setActiveSection] = useState<SectionKey>('recentlyLearned'); const [selected, setSelected] = useState<{ section: SectionConfig; item: ActivityItem } | null>(null)
  const [showAllLearned, setShowAllLearned] = useState(false)
  const load = useCallback(async (quiet = false) => { if (!quiet) setRefreshing(true); try { const { session } = await getSession(); if (!session) return; const params = new URLSearchParams({ workspaceId }); if (showAllLearned) params.set('allLearned', '1'); const response = await fetch(`/api/founder/operating-activity?${params.toString()}`, { headers: { Authorization: `Bearer ${session.access_token}` }, cache: 'no-store' }); if (!response.ok) throw new Error(`Operating activity request failed (${response.status})`); setData(await response.json()); setFailed(false) } catch (error) { console.error('[OperatingActivity] load failed', error); setFailed(true) } finally { if (!quiet) setRefreshing(false) } }, [workspaceId, showAllLearned])
  useEffect(() => { load(); const timer = window.setInterval(() => load(true), 30_000); return () => window.clearInterval(timer) }, [load])
  useEffect(() => { setSelected(null); setShowAllLearned(false) }, [workspaceId])
  const learnedTotal = data?.sectionTotals?.recentlyLearned ?? data?.sections.recentlyLearned.length ?? 0
  const learnedPreviewCount = Math.min(5, learnedTotal)
  const state = STATUS[data?.status ?? 'idle']; const counts = useMemo(() => data ? data.sections.researchingNow.length + learnedPreviewCount + data.sections.beliefChanges.length + data.sections.actionsTaken.length + data.sections.waitingOnHuman.length + data.sections.nextScheduledWork.length : 0, [data, learnedPreviewCount]); const needsYou = data?.sections.waitingOnHuman.length ?? 0; const working = data?.sections.researchingNow.length ?? 0; const learned = learnedPreviewCount
  const activeConfig = SECTIONS.find((section) => section.key === activeSection) ?? SECTIONS[1]; const activeItems = data?.sections[activeConfig.key] ?? []
  const activeTotal = activeSection === 'recentlyLearned' ? learnedTotal : activeItems.length
  const canToggleLearned = activeSection === 'recentlyLearned' && learnedTotal > 5
  return <section style={{ marginBottom: 32 }}>
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 12 }}>
      <div><div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.055em', color: TEXT_QUIET }}>CAYE RIGHT NOW</div><div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 4 }}>A quick view of what Caye is doing, learning, and waiting on.</div></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <div aria-live="polite" style={{ display: 'flex', alignItems: 'center', color: failed ? ROSE : state.color, fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap' }}><span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', marginRight: 6, background: failed ? ROSE : state.color, boxShadow: data?.status === 'working' ? `0 0 7px ${EMERALD}99` : undefined }} />{failed ? 'Activity unavailable' : refreshing && !data ? 'Checking…' : state.label}</div>
        <button type="button" onClick={() => load()} disabled={refreshing} aria-label="Refresh activity" title="Refresh activity" style={{ width: 27, height: 27, display: 'grid', placeItems: 'center', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, background: 'rgba(255,255,255,0.025)', color: TEXT_QUIET, cursor: refreshing ? 'default' : 'pointer', opacity: refreshing ? 0.45 : 1, fontSize: 14, lineHeight: 1 }}>{refreshing ? '·' : '↻'}</button>
      </div>
    </div>
    {failed && !data ? <div style={{ ...glass(0.035), borderRadius: 14, padding: '16px 18px', fontSize: 11.5, color: ROSE }}>I could not load live activity. I will keep trying.</div> : <div style={{ ...glass(0.025), borderRadius: 16, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{[{ label: 'Working now', value: working, color: working ? EMERALD : TEXT_QUIET }, { label: 'Learned recently', value: learned, color: learned ? EMERALD : TEXT_QUIET }, { label: 'Needs you', value: needsYou, color: needsYou ? ROSE : TEXT_QUIET }, { label: 'Total activity', value: counts, color: AQUA }].map((stat) => <div key={stat.label} style={{ padding: '13px 15px', borderRight: '1px solid rgba(255,255,255,0.05)' }}><div style={{ fontSize: 18, fontWeight: 600, color: stat.color }}>{stat.value}</div><div style={{ marginTop: 2, fontSize: 9.5, color: TEXT_QUIET }}>{stat.label}</div></div>)}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '190px minmax(0, 1fr)', minHeight: 250 }}><div style={{ padding: 8, borderRight: '1px solid rgba(255,255,255,0.06)' }}>{SECTIONS.map((section) => { const count = section.key === 'recentlyLearned' ? learnedPreviewCount : data?.sections[section.key].length ?? 0; const active = activeSection === section.key; return <button key={section.key} type="button" onClick={() => setActiveSection(section.key)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, border: 0, borderRadius: 9, background: active ? 'rgba(255,255,255,0.055)' : 'transparent', padding: '9px 10px', color: active ? TEXT : TEXT_MUTED, cursor: 'pointer', textAlign: 'left' }}><span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}><span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: count ? section.color : TEXT_QUIET }} /><span style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{section.shortTitle}</span></span><span style={{ fontSize: 9.5, color: active ? section.color : TEXT_QUIET }}>{count}</span></button> })}</div>
        <div style={{ minWidth: 0, padding: '12px 16px 10px' }}><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 3 }}><div style={{ fontSize: 11, fontWeight: 700, color: TEXT }}>{activeConfig.title}</div><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div style={{ fontSize: 9.5, color: TEXT_QUIET }}>{showAllLearned && activeSection === 'recentlyLearned' ? activeItems.length : Math.min(activeItems.length, 5)} item{activeTotal === 1 ? '' : 's'}</div>{canToggleLearned && <button type="button" onClick={() => setShowAllLearned((value) => !value)} style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', color: AQUA, font: '600 10px inherit' }}>{showAllLearned ? 'Show recent 5' : `View all ${learnedTotal}`}</button>}</div></div>{activeItems.length === 0 ? <div style={{ padding: '24px 2px', fontSize: 11.5, lineHeight: 1.5, color: TEXT_QUIET }}>{activeConfig.empty}</div> : <div>{activeItems.map((item, index) => <ActivityRow key={`${item.label}-${index}`} item={item} color={activeConfig.color} future={activeConfig.future} onOpen={() => setSelected({ section: activeConfig, item })} />)}</div>}</div></div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '7px 12px', borderTop: '1px solid rgba(255,255,255,0.05)', fontSize: 9.5, color: TEXT_QUIET }}>{data?.lastActivityAt ? `Last activity ${relativeTime(data.lastActivityAt)}` : 'No activity yet'} · updates every 30s</div>
    </div>}
    {selected && <ActivityDetail section={selected.section} item={selected.item} onClose={() => setSelected(null)} />}
  </section>
}
