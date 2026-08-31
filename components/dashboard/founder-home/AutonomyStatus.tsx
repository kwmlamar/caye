'use client'

import { useCallback, useEffect, useState } from 'react'
import { getSession } from '@/lib/supabase'
import { AQUA, EMERALD, GOLD, ROSE, TEXT, TEXT_MUTED, TEXT_QUIET, glass } from '../surface'

type ResearchItem = { title: string; detail: string | null; at: string | null; status: string }
type BeliefChange = { claim: string; rationale: string; priorConfidence: number | null; revisedConfidence: number; at: string }
type SelfImprovementItem = { task: string; status: string; testsPassed: boolean | null; buildPassed: boolean | null; commitSha: string | null; at: string; error: string | null }
type AttentionItem = { title: string; detail: string | null; priority: string; authority: string | null; at: string | null }
type AutonomyData = {
  generatedAt: string
  summary: {
    investigating: number
    monitoring: number
    beliefChanges7d: number
    needsYou: number
    selfImprovementActive: number
    selfImprovementCompleted: number
  }
  investigating: ResearchItem[]
  monitoring: ResearchItem[]
  beliefChanges: BeliefChange[]
  selfImprovement: SelfImprovementItem[]
  needsYou: AttentionItem[]
}

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

function MiniRow({ title, detail, meta, color }: { title: string; detail?: string | null; meta?: string | null; color: string }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '7px minmax(0,1fr) auto', alignItems: 'start', gap: 9, padding: '9px 0', borderBottom: '1px solid rgba(255,255,255,0.045)' }}>
    <span aria-hidden style={{ width: 6, height: 6, marginTop: 5, borderRadius: '50%', background: color }} />
    <div style={{ minWidth: 0 }}><div style={{ fontSize: 11.5, lineHeight: 1.45, color: TEXT }}>{title}</div>{detail && <div style={{ marginTop: 2, fontSize: 10.5, lineHeight: 1.45, color: TEXT_MUTED }}>{detail}</div>}</div>
    {meta && <div style={{ paddingLeft: 8, whiteSpace: 'nowrap', fontSize: 9.5, color: TEXT_QUIET }}>{meta}</div>}
  </div>
}

function Panel({ title, count, color, empty, children }: { title: string; count: number; color: string; empty: string; children: React.ReactNode }) {
  return <div style={{ ...glass(0.025), minWidth: 0, borderRadius: 13, padding: '12px 14px' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}><div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: count ? color : TEXT_QUIET }} /><span style={{ fontSize: 10.5, fontWeight: 700, color: TEXT }}>{title}</span></div><span style={{ fontSize: 10, color: count ? color : TEXT_QUIET }}>{count}</span></div>
    {count ? children : <div style={{ padding: '12px 0 4px', fontSize: 10.5, lineHeight: 1.45, color: TEXT_QUIET }}>{empty}</div>}
  </div>
}

export default function AutonomyStatus({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<AutonomyData | null>(null)
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const load = useCallback(async () => {
    try {
      const { session } = await getSession()
      if (!session) return
      const response = await fetch(`/api/founder/autonomy-status?workspaceId=${encodeURIComponent(workspaceId)}`, { headers: { Authorization: `Bearer ${session.access_token}` }, cache: 'no-store' })
      if (!response.ok) throw new Error(`Autonomy status failed (${response.status})`)
      setData(await response.json())
      setFailed(false)
    } catch (error) {
      console.error('[AutonomyStatus] load failed', error)
      setFailed(true)
    }
  }, [workspaceId])

  useEffect(() => { load(); const timer = window.setInterval(load, 60_000); return () => window.clearInterval(timer) }, [load])

  if (failed && !data) return null
  if (!data) return <section style={{ marginBottom: 28 }}><div style={{ ...glass(0.025), borderRadius: 14, padding: '16px 18px', fontSize: 11, color: TEXT_QUIET }}>Checking Caye's autonomous work…</div></section>

  const s = data.summary
  const operating = s.monitoring > 0 || s.investigating > 0
  const codingLive = s.selfImprovementActive > 0
  const latestCoding = data.selfImprovement[0]

  return <section style={{ marginBottom: 30 }}>
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 14, marginBottom: 10 }}>
      <div><div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.055em', color: TEXT_QUIET }}>AUTONOMY</div><div style={{ marginTop: 4, fontSize: 11.5, color: TEXT_MUTED }}>What Caye is pursuing without waiting for another prompt, and where human judgment still gates her.</div></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap', fontSize: 10.5, fontWeight: 650, color: operating ? EMERALD : TEXT_QUIET }}><span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: operating ? EMERALD : TEXT_QUIET, boxShadow: operating ? `0 0 7px ${EMERALD}88` : undefined }} />{operating ? 'Operating autonomously' : 'No autonomous work active'}</div>
    </div>

    <div style={{ ...glass(0.02), borderRadius: 15, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,minmax(0,1fr))', borderBottom: '1px solid rgba(255,255,255,0.055)' }}>
        {[
          { label: 'Investigating', value: s.investigating, color: AQUA },
          { label: 'Monitoring', value: s.monitoring, color: EMERALD },
          { label: 'Mind changes · 7d', value: s.beliefChanges7d, color: GOLD },
          { label: 'Improving herself', value: s.selfImprovementActive, color: AQUA },
          { label: 'Needs your judgment', value: s.needsYou, color: ROSE },
        ].map((item) => <div key={item.label} style={{ padding: '12px 14px', borderRight: '1px solid rgba(255,255,255,0.05)' }}><div style={{ fontSize: 18, fontWeight: 650, color: item.value ? item.color : TEXT_QUIET }}>{item.value}</div><div style={{ marginTop: 2, fontSize: 9.5, color: TEXT_QUIET }}>{item.label}</div></div>)}
      </div>

      <div style={{ padding: '12px 16px' }}>
        <div style={{ fontSize: 11.5, lineHeight: 1.55, color: TEXT_MUTED }}>
          {s.monitoring > 0 ? `Caye has ${s.monitoring} standing research stream${s.monitoring === 1 ? '' : 's'} watching the world.` : 'No standing world-monitoring stream is active.'}
          {' '}{s.investigating > 0 ? `${s.investigating} investigation${s.investigating === 1 ? ' is' : 's are'} actively in flight.` : 'Nothing is actively being investigated this minute.'}
          {' '}{s.needsYou > 0 ? `${s.needsYou} item${s.needsYou === 1 ? '' : 's'} genuinely need your judgment.` : 'Nothing currently needs your judgment.'}
        </div>
        <div style={{ marginTop: 7, fontSize: 10.5, lineHeight: 1.5, color: codingLive ? AQUA : TEXT_QUIET }}>
          {codingLive
            ? `Self-improvement is active: ${s.selfImprovementActive} coding session${s.selfImprovementActive === 1 ? '' : 's'} in progress.`
            : latestCoding?.status === 'failed'
              ? 'Self-improvement infrastructure exists, but autonomous self-coding is not live yet. The latest coding session failed, so Caye is not claiming otherwise.'
              : s.selfImprovementCompleted > 0
                ? `Self-improvement infrastructure has ${s.selfImprovementCompleted} recent completed session${s.selfImprovementCompleted === 1 ? '' : 's'}, but no coding session is active now.`
                : 'Self-improvement infrastructure exists, but autonomous self-coding is not live yet.'}
        </div>
        <button type="button" onClick={() => setExpanded((value) => !value)} style={{ marginTop: 10, border: 0, background: 'transparent', padding: 0, color: AQUA, fontSize: 10.5, fontWeight: 650, cursor: 'pointer' }}>{expanded ? 'Hide autonomy details' : 'View autonomy details'}</button>
      </div>

      {expanded && <div style={{ padding: '0 16px 16px', display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 10 }}>
        <Panel title="Investigating now" count={data.investigating.length} color={AQUA} empty="No investigation is in flight right now. Standing monitoring can still schedule the next one.">{data.investigating.slice(0, 5).map((item, index) => <MiniRow key={`${item.title}-${index}`} title={item.title} detail={item.detail} meta={relativeTime(item.at)} color={AQUA} />)}</Panel>
        <Panel title="Monitoring continuously" count={data.monitoring.length} color={EMERALD} empty="No standing research desk is active.">{data.monitoring.slice(0, 6).map((item, index) => <MiniRow key={`${item.title}-${index}`} title={item.title} detail={item.detail} meta={item.at ? `next ${relativeTime(item.at)}` : null} color={EMERALD} />)}</Panel>
        <Panel title="Changed my mind" count={data.beliefChanges.length} color={GOLD} empty="No durable belief revision has been recorded in the last 7 days.">{data.beliefChanges.slice(0, 5).map((item, index) => <MiniRow key={`${item.claim}-${index}`} title={item.claim} detail={item.rationale} meta={`${item.priorConfidence == null ? '?' : Math.round(item.priorConfidence * 100)}% → ${Math.round(item.revisedConfidence * 100)}%`} color={GOLD} />)}</Panel>
        <Panel title="Improving herself" count={data.selfImprovement.length} color={AQUA} empty="No coding session has been recorded yet.">{data.selfImprovement.slice(0, 4).map((item, index) => <MiniRow key={`${item.task}-${index}`} title={item.task} detail={item.error ? `Failed: ${item.error}` : item.commitSha ? `Commit ${item.commitSha.slice(0, 8)} · tests ${item.testsPassed ? 'passed' : 'unverified'} · build ${item.buildPassed ? 'passed' : 'unverified'}` : null} meta={item.status} color={item.status === 'failed' ? ROSE : item.status === 'completed' || item.status === 'succeeded' || item.status === 'merged' ? EMERALD : AQUA} />)}</Panel>
        <div style={{ gridColumn: '1 / -1' }}><Panel title="Needs your judgment" count={data.needsYou.length} color={ROSE} empty="Nothing is blocked on you. Caye should keep moving inside her existing authority.">{data.needsYou.slice(0, 6).map((item, index) => <MiniRow key={`${item.title}-${index}`} title={item.title} detail={[item.detail, item.authority ? `Authority: ${item.authority}` : null].filter(Boolean).join(' · ')} meta={item.priority} color={ROSE} />)}</Panel></div>
      </div>}
    </div>
  </section>
}
