'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getSession } from '@/lib/supabase'
import { CayeLoadingPulse } from './CayeLoadingPulse'
import OperatingActivity from './OperatingActivity'
import { AQUA, EMERALD, GOLD, ROSE, TEXT, TEXT_MUTED, TEXT_QUIET, glass } from '../surface'

type GoalKind = 'vision' | 'domain' | 'objective' | 'goal' | 'initiative'
type GoalStatus = 'active' | 'future' | 'blocked' | 'paused' | 'completed' | 'abandoned'
type GoalPriority = 'low' | 'medium' | 'high' | 'critical'
type MaturityStatus = 'unverified' | 'foundation' | 'limited' | 'active' | 'future'

interface Goal {
  id: string
  kind: GoalKind
  parentId: string | null
  scope: 'operator' | 'workspace'
  workspaceId: string | null
  title: string
  description: string | null
  status: GoalStatus
  priority: GoalPriority
  targetValue: number | null
  currentValue: number | null
  unit: string | null
  completionCriteria: string | null
}

interface CapabilityEvidence {
  id: number
  evidence_kind: string
  source_ref: string
  summary: string
  verifies_capability: boolean
  confidence: number | null
  observed_at: string
  verified_at: string | null
}

interface CapabilityGoalLink {
  relationship: string
  goal: { id: string; title: string; kind: GoalKind; status: GoalStatus; parent_id: string | null }
}

interface Capability {
  id: string
  key: string
  title: string
  description: string
  maturityStatus: MaturityStatus
  limitations: string[]
  progressPercent: number | null
  lastVerifiedAt: string | null
  evidence: CapabilityEvidence[]
  dependencies: Array<{ note: string | null; capability: { id: string; title: string } }>
  relatedObjectives: CapabilityGoalLink[]
  relatedInitiatives: CapabilityGoalLink[]
}

const STATUS_COLOR: Record<GoalStatus, string> = {
  active: EMERALD,
  future: TEXT_QUIET,
  blocked: ROSE,
  paused: GOLD,
  completed: AQUA,
  abandoned: TEXT_QUIET,
}
const STATUS_LABEL: Record<GoalStatus, string> = {
  active: 'active', future: 'future', blocked: 'blocked', paused: 'paused', completed: 'completed', abandoned: 'superseded',
}
const PRIORITY_WEIGHT: Record<GoalPriority, number> = { critical: 4, high: 3, medium: 2, low: 1 }
const MATURITY_COLOR: Record<MaturityStatus, string> = {
  unverified: TEXT_QUIET,
  foundation: GOLD,
  limited: ROSE,
  active: EMERALD,
  future: TEXT_QUIET,
}

function StatusDot({ status }: { status: GoalStatus }) {
  return <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', display: 'inline-block', flexShrink: 0, background: STATUS_COLOR[status], boxShadow: status === 'active' ? `0 0 6px ${STATUS_COLOR[status]}99` : undefined }} />
}

function useDirectionData(workspaceId: string) {
  const [data, setData] = useState<{ operatorGoals: Goal[]; workspaceGoals: Goal[]; capabilities: Capability[] } | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { session } = await getSession()
    if (!session) { setLoading(false); return }
    const headers = { Authorization: `Bearer ${session.access_token}` }
    const [goalsRes, capabilitiesRes] = await Promise.all([
      fetch(`/api/founder/goals?workspaceId=${workspaceId}`, { headers }),
      fetch('/api/founder/goals/capabilities', { headers }),
    ])
    if (!goalsRes.ok) { setLoading(false); return }
    const goalsJson = await goalsRes.json()
    const capabilitiesJson = capabilitiesRes.ok ? await capabilitiesRes.json() : { capabilities: [] }
    setData({
      operatorGoals: goalsJson.operatorGoals ?? [],
      workspaceGoals: goalsJson.workspaceGoals ?? [],
      capabilities: capabilitiesJson.capabilities ?? [],
    })
    setLoading(false)
  }, [workspaceId])

  useEffect(() => { setLoading(true); load() }, [load])
  return { data, loading, refetch: load }
}

function CapabilityCard({ capability }: { capability: Capability }) {
  const [expanded, setExpanded] = useState(false)
  const maturityColor = MATURITY_COLOR[capability.maturityStatus]
  const verifiedEvidence = capability.evidence.filter((item) => item.verifies_capability)

  return (
    <div style={{ ...glass(0.035), borderRadius: 12, padding: '12px 14px' }}>
      <button type="button" onClick={() => setExpanded((value) => !value)} style={{ width: '100%', border: 0, background: 'transparent', padding: 0, textAlign: 'left', cursor: 'pointer', color: TEXT }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: maturityColor, boxShadow: capability.maturityStatus === 'active' ? `0 0 7px ${maturityColor}88` : undefined }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 650 }}>{capability.title}</span>
              <span style={{ fontSize: 10.5, color: maturityColor, fontWeight: 700 }}>{capability.maturityStatus.toUpperCase()}</span>
              {capability.progressPercent !== null && <span style={{ fontSize: 10.5, color: AQUA }}>{capability.progressPercent}% verified progress</span>}
            </div>
            <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 3, lineHeight: 1.45 }}>{capability.description}</div>
          </div>
          <span aria-hidden style={{ color: TEXT_QUIET, fontSize: 11 }}>{expanded ? '▾' : '▸'}</span>
        </div>
      </button>

      {expanded && (
        <div style={{ marginTop: 11, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.055)', display: 'grid', gap: 9 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 10.5, color: TEXT_QUIET }}>
            <span>{verifiedEvidence.length} verified evidence item{verifiedEvidence.length === 1 ? '' : 's'}</span>
            {capability.lastVerifiedAt ? <span>last verified {new Date(capability.lastVerifiedAt).toLocaleDateString()}</span> : <span>not yet verified</span>}
          </div>

          {capability.limitations.length > 0 && <div style={{ fontSize: 11, color: ROSE }}>Gaps: {capability.limitations.join('; ')}</div>}

          {capability.relatedObjectives.length > 0 && (
            <div style={{ fontSize: 11, color: TEXT_MUTED }}>
              <span style={{ color: TEXT_QUIET }}>Objectives · </span>{capability.relatedObjectives.map((link) => link.goal.title).join(' · ')}
            </div>
          )}

          {capability.relatedInitiatives.length > 0 && (
            <div style={{ fontSize: 11, color: TEXT_MUTED }}>
              <span style={{ color: AQUA }}>Initiatives · </span>{capability.relatedInitiatives.map((link) => link.goal.title).join(' · ')}
            </div>
          )}

          {capability.dependencies.length > 0 && (
            <div style={{ fontSize: 11, color: TEXT_MUTED }}>
              <span style={{ color: TEXT_QUIET }}>Depends on · </span>{capability.dependencies.map((dependency) => dependency.capability.title).join(' · ')}
            </div>
          )}

          {capability.evidence.length === 0 ? (
            <div style={{ fontSize: 10.5, color: TEXT_QUIET, fontStyle: 'italic' }}>No capability evidence recorded. Code existence alone does not advance maturity.</div>
          ) : capability.evidence.map((item) => (
            <div key={item.id} style={{ fontSize: 10.5, color: TEXT_MUTED, padding: '3px 0', display: 'grid', gridTemplateColumns: '76px 1fr', gap: 8 }}>
              <span style={{ color: item.verifies_capability ? EMERALD : TEXT_QUIET }}>{item.verifies_capability ? 'verified' : 'supporting'}</span>
              <span><span style={{ color: TEXT }}>{item.summary}</span> · {item.evidence_kind} · {item.source_ref}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CapabilitiesSection({ capabilities }: { capabilities: Capability[] }) {
  if (!capabilities.length) return null
  const verified = capabilities.filter((capability) => capability.lastVerifiedAt && capability.evidence.some((item) => item.verifies_capability)).length

  return (
    <section style={{ marginBottom: 32 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.055em', color: TEXT_QUIET }}>OPERATING INTELLIGENCE CAPABILITIES</div>
          <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 4 }}>Cross-domain abilities connecting Direction objectives to real initiatives and verified evidence.</div>
        </div>
        <div style={{ fontSize: 10.5, color: TEXT_QUIET, whiteSpace: 'nowrap' }}>{verified}/{capabilities.length} verified</div>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {capabilities.map((capability) => <CapabilityCard key={capability.id} capability={capability} />)}
      </div>
    </section>
  )
}

function GoalNode({ goal, depth, byParent }: { goal: Goal; depth: number; byParent: Map<string, Goal[]> }) {
  const children = byParent.get(goal.id) ?? []
  const [expanded, setExpanded] = useState(depth < 1)
  const progress = goal.targetValue !== null && goal.currentValue !== null && goal.unit ? `${goal.currentValue} / ${goal.targetValue} ${goal.unit}` : null

  return (
    <div style={{ marginLeft: depth * 16 }}>
      <button type="button" onClick={() => children.length > 0 && setExpanded((value) => !value)} style={{ width: '100%', display: 'flex', alignItems: 'flex-start', gap: 8, textAlign: 'left', padding: '7px 8px', border: 0, borderRadius: 8, cursor: children.length > 0 ? 'pointer' : 'default', background: 'transparent', color: TEXT }}>
        {children.length > 0 ? <span aria-hidden style={{ color: TEXT_QUIET, fontSize: 10, marginTop: 3, width: 10, flexShrink: 0 }}>{expanded ? '▾' : '▸'}</span> : <span style={{ width: 10, flexShrink: 0 }} />}
        <StatusDot status={goal.status} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: goal.kind === 'vision' || goal.kind === 'domain' ? 600 : 500 }}>{goal.kind === 'domain' ? goal.title.toUpperCase() : goal.title}</span>
          <span style={{ marginLeft: 8, fontSize: 10.5, color: TEXT_QUIET }}>{STATUS_LABEL[goal.status]}{goal.priority !== 'medium' ? ` · ${goal.priority}` : ''}</span>
          {goal.description && <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 2 }}>{goal.description}</div>}
          {progress && <div style={{ fontSize: 11, color: TEXT_QUIET, marginTop: 2 }}>{progress}</div>}
          {!progress && goal.completionCriteria && <div style={{ fontSize: 11, color: TEXT_QUIET, marginTop: 2, fontStyle: 'italic' }}>Done when: {goal.completionCriteria}</div>}
        </span>
      </button>
      {expanded && children.length > 0 && <div>{children.map((child) => <GoalNode key={child.id} goal={child} depth={depth + 1} byParent={byParent} />)}</div>}
    </div>
  )
}

function TreeSection({ title, goals }: { title: string; goals: Goal[] }) {
  const byParent = useMemo(() => {
    const map = new Map<string, Goal[]>()
    for (const goal of goals) {
      if (!goal.parentId) continue
      const list = map.get(goal.parentId) ?? []
      list.push(goal)
      map.set(goal.parentId, list)
    }
    for (const list of map.values()) list.sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority])
    return map
  }, [goals])
  const roots = goals.filter((goal) => !goal.parentId).sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority])
  if (!roots.length) return null
  return <div style={{ marginBottom: 20 }}><div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', color: TEXT_QUIET, marginBottom: 6 }}>{title.toUpperCase()}</div>{roots.map((goal) => <GoalNode key={goal.id} goal={goal} depth={0} byParent={byParent} />)}</div>
}

export default function DirectionPage({ workspaceId }: { workspaceId: string }) {
  const { data, loading, refetch } = useDirectionData(workspaceId)
  const [seeding, setSeeding] = useState(false)

  async function handleSeed() {
    setSeeding(true)
    try {
      const { session } = await getSession()
      if (!session) return
      await fetch('/api/founder/goals/seed', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` } })
      await refetch()
    } finally { setSeeding(false) }
  }

  const vision = data?.operatorGoals.find((goal) => goal.kind === 'vision')
  const domains = data?.operatorGoals.filter((goal) => goal.kind === 'domain') ?? []
  const activeFocus = useMemo(() => {
    const all = [...(data?.operatorGoals ?? []), ...(data?.workspaceGoals ?? [])]
    return all
      .filter((goal) => goal.status === 'active' && (goal.kind === 'objective' || goal.kind === 'goal' || goal.kind === 'initiative'))
      .sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority])
      .slice(0, 8)
  }, [data])

  if (loading) return <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '28px 32px 60px' }}><CayeLoadingPulse label="Loading direction…" /></div>

  if (!data || (!data.operatorGoals.length && !data.workspaceGoals.length)) {
    return <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '28px 32px 60px' }}><div style={{ maxWidth: 460, margin: '60px auto', textAlign: 'center' }}><div style={{ fontSize: 15, fontWeight: 600, color: TEXT, marginBottom: 8 }}>No direction set yet</div><div style={{ fontSize: 13, color: TEXT_MUTED, marginBottom: 20, lineHeight: 1.5 }}>Caye has no durable objectives to reason against yet.</div><button type="button" onClick={handleSeed} disabled={seeding} style={{ padding: '9px 18px', borderRadius: 10, border: 0, cursor: seeding ? 'default' : 'pointer', background: 'rgba(78,190,206,0.14)', color: AQUA, font: '600 12.5px inherit', opacity: seeding ? 0.6 : 1 }}>{seeding ? 'Seeding…' : 'Seed starter direction'}</button></div></div>
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '28px 32px 60px' }}>
      <div style={{ maxWidth: 760 }}>
        {vision && <div style={{ marginBottom: 22 }}><div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em', color: TEXT_QUIET, marginBottom: 6 }}>DIRECTION</div><div style={{ fontSize: 17, fontWeight: 600, color: TEXT, lineHeight: 1.35 }}>{vision.title}</div>{vision.description && <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginTop: 6, lineHeight: 1.5, maxWidth: 600 }}>{vision.description}</div>}</div>}

        {domains.length > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 26 }}>{domains.map((domain) => <div key={domain.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999, ...glass(0.04) }}><StatusDot status={domain.status} /><span style={{ fontSize: 11.5, fontWeight: 600, color: TEXT }}>{domain.title.toUpperCase()}</span><span style={{ fontSize: 10.5, color: TEXT_QUIET }}>({STATUS_LABEL[domain.status]})</span></div>)}</div>}

        {activeFocus.length > 0 && <div style={{ marginBottom: 30 }}><div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', color: TEXT_QUIET, marginBottom: 8 }}>CURRENT FOCUS</div>{activeFocus.map((goal) => <div key={goal.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 2px', fontSize: 13, color: TEXT }}><span aria-hidden style={{ color: AQUA }}>→</span>{goal.title}{goal.scope === 'workspace' && <span style={{ fontSize: 10, color: TEXT_QUIET, ...glass(0.05), padding: '1px 6px', borderRadius: 999 }}>this workspace</span>}</div>)}</div>}

        <OperatingActivity workspaceId={workspaceId} />
        <CapabilitiesSection capabilities={data.capabilities} />
        <TreeSection title="Operator direction" goals={data.operatorGoals} />
        <TreeSection title="This workspace" goals={data.workspaceGoals} />
      </div>
    </div>
  )
}
