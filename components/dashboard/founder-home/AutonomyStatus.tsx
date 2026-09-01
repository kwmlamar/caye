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
  summary: { investigating: number; monitoring: number; beliefChanges7d: number; needsYou: number; selfImprovementActive: number; selfImprovementCompleted: number }
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

function Row({ title, detail, meta, color }: { title: string; detail?: string | null; meta?: string | null; color: string }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '7px minmax(0,1fr) auto', alignItems: 'start', gap: 10, padding: '11px 0', borderBottom: '1px solid rgba(255,255,255,0.045)' }}>
    <span aria-hidden style={{ width: 6, height: 6, marginTop: 6, borderRadius: '50%', background: color, boxShadow: `0 0 6px ${color}55` }} />
    <div style={{ minWidth: 0 }}><div style={{ fontSize: 12, lineHeight: 1.45, color: TEXT }}>{title}</div>{detail && <div style={{ marginTop: 3, fontSize: 10.5, lineHeight: 1.5, color: TEXT_MUTED }}>{detail}</div>}</div>
    {meta && <div style={{ paddingLeft: 8, whiteSpace: 'nowrap', fontSize: 9.5, color: TEXT_QUIET }}>{meta}</div>}
  </div>
}

function WorkPanel({ title, count, color, empty, children }: { title: string; count: number; color: string; empty: string; children: React.ReactNode }) {
  return <div style={{ ...glass(0.022), minWidth: 0, borderRadius: 13, padding: '12px 14px' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}><div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: count ? color : TEXT_QUIET }} /><span style={{ fontSize: 10.5, fontWeight: 700, color: TEXT }}>{title}</span></div><span style={{ fontSize: 10, color: count ? color : TEXT_QUIET }}>{count}</span></div>
    {count ? children : <div style={{ padding: '13px 0 3px', fontSize: 10.5, lineHeight: 1.5, color: TEXT_QUIET }}>{empty}</div>}
  </div>
}

export default function AutonomyStatus({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<AutonomyData | null>(null)
  const [failed, setFailed] = useState(false)
  const [showWatching, setShowWatching] = useState(false)

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
  const operating = s.monitoring > 0 || s.investigating > 0 || s.selfImprovementActive > 0
  const latestCoding = data.selfImprovement[0]
  const completedCoding = data.selfImprovement.filter((item) => ['completed', 'succeeded', 'merged'].includes(item.status))
  const meaningfulChanges = data.beliefChanges.slice(0, 4)
  const activeCoding = data.selfImprovement.filter((item) => ['queued', 'starting', 'running', 'testing', 'building'].includes(item.status))

  return <section style={{ marginBottom: 30 }}>
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 14, marginBottom: 10 }}>
      <div><div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.055em', color: TEXT_QUIET }}>CAYE RIGHT NOW</div><div style={{ marginTop: 4, fontSize: 11.5, color: TEXT_MUTED }}>What Caye is doing for you without waiting for another prompt.</div></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap', fontSize: 10.5, fontWeight: 650, color: operating ? EMERALD : TEXT_QUIET }}><span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: operating ? EMERALD : TEXT_QUIET, boxShadow: operating ? `0 0 7px ${EMERALD}88` : undefined }} />{operating ? 'Operating autonomously' : 'Waiting for work'}</div>
    </div>

    <div style={{ ...glass(0.02), borderRadius: 15, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,minmax(0,1fr))', borderBottom: '1px solid rgba(255,255,255,0.055)' }}>
        {[
          { label: 'Working', value: s.investigating + s.selfImprovementActive, color: AQUA },
          { label: 'Watching', value: s.monitoring, color: EMERALD },
          { label: 'Changed mind · 7d', value: s.beliefChanges7d, color: GOLD },
          { label: 'Improving herself', value: s.selfImprovementActive, color: AQUA },
          { label: 'Needs you', value: s.needsYou, color: ROSE },
        ].map((item) => <div key={item.label} style={{ padding: '13px 15px', borderRight: '1px solid rgba(255,255,255,0.05)' }}><div style={{ fontSize: 19, fontWeight: 650, color: item.value ? item.color : TEXT_QUIET }}>{item.value}</div><div style={{ marginTop: 2, fontSize: 9.5, color: TEXT_QUIET }}>{item.label}</div></div>)}
      </div>

      <div style={{ padding: '4px 16px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: s.needsYou > 0 ? 'minmax(0,1.35fr) minmax(0,0.9fr)' : '1fr', gap: 12, marginTop: 10 }}>
          <WorkPanel title="Working now" count={data.investigating.length + activeCoding.length} color={AQUA} empty={s.monitoring ? `Nothing is actively in flight this minute. Caye is still watching ${s.monitoring} standing stream${s.monitoring === 1 ? '' : 's'} and will start work when one becomes due.` : 'Nothing is actively in flight right now.'}>
            {data.investigating.slice(0, 4).map((item, index) => <Row key={`${item.title}-${index}`} title={item.title} detail={item.detail} meta={relativeTime(item.at)} color={AQUA} />)}
            {activeCoding.slice(0, 2).map((item, index) => <Row key={`${item.task}-${index}`} title={`Improving herself · ${item.task}`} detail={item.commitSha ? `Commit ${item.commitSha.slice(0, 8)}` : 'Running through the existing coding gates.'} meta={item.status} color={AQUA} />)}
          </WorkPanel>

          {s.needsYou > 0 && <WorkPanel title="Needs your judgment" count={data.needsYou.length} color={ROSE} empty="Nothing is blocked on you.">{data.needsYou.slice(0, 5).map((item, index) => <Row key={`${item.title}-${index}`} title={item.title} detail={[item.detail, item.authority ? `Authority: ${item.authority}` : null].filter(Boolean).join(' · ')} meta={item.priority} color={ROSE} />)}</WorkPanel>}
        </div>

        {(meaningfulChanges.length > 0 || completedCoding.length > 0) && <div style={{ marginTop: 12 }}><WorkPanel title="What changed" count={meaningfulChanges.length + completedCoding.length} color={GOLD} empty="No material change yet.">
          {meaningfulChanges.map((item, index) => <Row key={`${item.claim}-${index}`} title={item.claim} detail={item.rationale} meta={`${item.priorConfidence == null ? '?' : Math.round(item.priorConfidence * 100)}% → ${Math.round(item.revisedConfidence * 100)}%`} color={GOLD} />)}
          {completedCoding.slice(0, 2).map((item, index) => <Row key={`${item.task}-${index}`} title={`Self-improvement completed · ${item.task}`} detail={item.commitSha ? `Commit ${item.commitSha.slice(0, 8)} · tests ${item.testsPassed ? 'passed' : 'unverified'} · build ${item.buildPassed ? 'passed' : 'unverified'}` : null} meta={relativeTime(item.at)} color={EMERALD} />)}
        </WorkPanel></div>}

        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 10.5, lineHeight: 1.5, color: TEXT_QUIET }}>
            {s.monitoring > 0 ? `${s.monitoring} standing stream${s.monitoring === 1 ? '' : 's'} watching quietly.` : 'No standing monitoring stream is active.'}
            {' '}{s.needsYou === 0 ? 'Nothing currently needs your judgment.' : ''}
            {' '}{s.selfImprovementActive === 0 && latestCoding?.status === 'failed' ? 'Self-coding is not live yet; the latest coding session failed.' : s.selfImprovementActive === 0 && s.selfImprovementCompleted === 0 ? 'Self-coding is not live yet.' : ''}
          </div>
          {s.monitoring > 0 && <button type="button" onClick={() => setShowWatching((value) => !value)} style={{ flexShrink: 0, border: 0, background: 'transparent', padding: 0, color: AQUA, fontSize: 10.5, fontWeight: 650, cursor: 'pointer' }}>{showWatching ? 'Hide watching' : `View ${s.monitoring} watching`}</button>}
        </div>

        {showWatching && data.monitoring.length > 0 && <div style={{ marginTop: 10 }}><WorkPanel title="Watching quietly" count={data.monitoring.length} color={EMERALD} empty="No standing research desk is active.">{data.monitoring.slice(0, 8).map((item, index) => <Row key={`${item.title}-${index}`} title={item.title} detail={item.detail} meta={item.at ? `next ${relativeTime(item.at)}` : null} color={EMERALD} />)}</WorkPanel></div>}
      </div>
    </div>
  </section>
}
