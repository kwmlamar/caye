'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getSession } from '@/lib/supabase'
import { CayeLoadingPulse } from './CayeLoadingPulse'
import AutonomyStatus from './AutonomyStatus'
import IntelligenceSection from './IntelligenceSection'
import { AQUA, EMERALD, GOLD, ROSE, TEXT, TEXT_MUTED, TEXT_QUIET, glass } from '../surface'

type GoalKind = 'vision' | 'domain' | 'objective' | 'goal' | 'initiative'
type GoalStatus = 'active' | 'future' | 'blocked' | 'paused' | 'completed' | 'abandoned'
type GoalPriority = 'low' | 'medium' | 'high' | 'critical'
type MaturityStatus = 'unverified' | 'foundation' | 'limited' | 'active' | 'future'
type Goal = { id: string; kind: GoalKind; parentId: string | null; scope: 'operator' | 'workspace'; workspaceId: string | null; title: string; description: string | null; status: GoalStatus; priority: GoalPriority; targetValue: number | null; currentValue: number | null; unit: string | null; completionCriteria: string | null }
type CapabilityEvidence = { id: number; evidence_kind: string; source_ref: string; summary: string; verifies_capability: boolean; confidence: number | null; observed_at: string; verified_at: string | null }
type CapabilityGoalLink = { relationship: string; goal: { id: string; title: string; kind: GoalKind; status: GoalStatus; parent_id: string | null } }
type Capability = { id: string; key: string; title: string; description: string; maturityStatus: MaturityStatus; limitations: string[]; progressPercent: number | null; lastVerifiedAt: string | null; evidence: CapabilityEvidence[]; dependencies: Array<{ note: string | null; capability: { id: string; title: string } }>; relatedObjectives: CapabilityGoalLink[]; relatedInitiatives: CapabilityGoalLink[] }

const STATUS_COLOR: Record<GoalStatus, string> = { active: EMERALD, future: TEXT_QUIET, blocked: ROSE, paused: GOLD, completed: AQUA, abandoned: TEXT_QUIET }
const STATUS_LABEL: Record<GoalStatus, string> = { active: 'active', future: 'future', blocked: 'blocked', paused: 'paused', completed: 'completed', abandoned: 'superseded' }
const PRIORITY_WEIGHT: Record<GoalPriority, number> = { critical: 4, high: 3, medium: 2, low: 1 }
const MATURITY_COLOR: Record<MaturityStatus, string> = { unverified: TEXT_QUIET, foundation: GOLD, limited: ROSE, active: EMERALD, future: TEXT_QUIET }

function StatusDot({ status }: { status: GoalStatus }) { return <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', display: 'inline-block', flexShrink: 0, background: STATUS_COLOR[status], boxShadow: status === 'active' ? `0 0 6px ${STATUS_COLOR[status]}99` : undefined }} /> }

function useDirectionData(workspaceId: string) {
  const [data, setData] = useState<{ operatorGoals: Goal[]; workspaceGoals: Goal[]; capabilities: Capability[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    const { session } = await getSession(); if (!session) { setLoading(false); return }
    const headers = { Authorization: `Bearer ${session.access_token}` }
    const [goalsRes, capabilitiesRes] = await Promise.all([fetch(`/api/founder/goals?workspaceId=${workspaceId}`, { headers }), fetch('/api/founder/goals/capabilities', { headers })])
    if (!goalsRes.ok) { setLoading(false); return }
    const goalsJson = await goalsRes.json(); const capabilitiesJson = capabilitiesRes.ok ? await capabilitiesRes.json() : { capabilities: [] }
    setData({ operatorGoals: goalsJson.operatorGoals ?? [], workspaceGoals: goalsJson.workspaceGoals ?? [], capabilities: capabilitiesJson.capabilities ?? [] }); setLoading(false)
  }, [workspaceId])
  useEffect(() => { setLoading(true); load() }, [load])
  return { data, loading, refetch: load }
}

function CapabilityCard({ capability }: { capability: Capability }) {
  const [expanded, setExpanded] = useState(false); const color = MATURITY_COLOR[capability.maturityStatus]; const verifiedEvidence = capability.evidence.filter((item) => item.verifies_capability)
  return <div style={{ ...glass(0.035), borderRadius: 12, padding: '12px 14px' }}><button type="button" onClick={() => setExpanded((value) => !value)} style={{ width: '100%', border: 0, background: 'transparent', padding: 0, textAlign: 'left', cursor: 'pointer', color: TEXT }}><div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: color }} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}><span style={{ fontSize: 13, fontWeight: 650 }}>{capability.title}</span><span style={{ fontSize: 10.5, color, fontWeight: 700 }}>{capability.maturityStatus.toUpperCase()}</span>{capability.progressPercent !== null && <span style={{ fontSize: 10.5, color: AQUA }}>{capability.progressPercent}% verified progress</span>}</div><div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 3, lineHeight: 1.45 }}>{capability.description}</div></div><span aria-hidden style={{ color: TEXT_QUIET, fontSize: 11 }}>{expanded ? '▾' : '▸'}</span></div></button>{expanded && <div style={{ marginTop: 11, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.055)', display: 'grid', gap: 9 }}><div style={{ fontSize: 10.5, color: TEXT_QUIET }}>{verifiedEvidence.length} verified evidence item{verifiedEvidence.length === 1 ? '' : 's'}{capability.lastVerifiedAt ? ` · last verified ${new Date(capability.lastVerifiedAt).toLocaleDateString()}` : ' · not yet verified'}</div>{capability.limitations.length > 0 && <div style={{ fontSize: 11, color: ROSE }}>Needs work: {capability.limitations.join('; ')}</div>}{capability.evidence.map((item) => <div key={item.id} style={{ fontSize: 10.5, color: TEXT_MUTED }}><span style={{ color: item.verifies_capability ? EMERALD : TEXT_QUIET }}>{item.verifies_capability ? 'verified' : 'supporting'}</span> · {item.summary}</div>)}</div>}</div>
}

function CapabilitiesSection({ capabilities }: { capabilities: Capability[] }) { if (!capabilities.length) return null; const verified = capabilities.filter((capability) => capability.lastVerifiedAt && capability.evidence.some((item) => item.verifies_capability)).length; return <section style={{ marginBottom: 32 }}><div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}><div><div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.055em', color: TEXT_QUIET }}>CAPABILITY FOUNDATION</div><div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 4 }}>Secondary view: what the architecture can support, with evidence and limitations.</div></div><div style={{ fontSize: 10.5, color: TEXT_QUIET }}>{verified}/{capabilities.length} verified</div></div><div style={{ display: 'grid', gap: 8 }}>{capabilities.map((capability) => <CapabilityCard key={capability.id} capability={capability} />)}</div></section> }

function GoalNode({ goal, depth, byParent }: { goal: Goal; depth: number; byParent: Map<string, Goal[]> }) { const children = byParent.get(goal.id) ?? []; const [expanded, setExpanded] = useState(depth < 1); const progress = goal.targetValue !== null && goal.currentValue !== null && goal.unit ? `${goal.currentValue} / ${goal.targetValue} ${goal.unit}` : null; return <div style={{ marginLeft: depth * 16 }}><button type="button" onClick={() => children.length > 0 && setExpanded((value) => !value)} style={{ width: '100%', display: 'flex', alignItems: 'flex-start', gap: 8, textAlign: 'left', padding: '7px 8px', border: 0, background: 'transparent', color: TEXT, cursor: children.length ? 'pointer' : 'default' }}>{children.length > 0 ? <span style={{ color: TEXT_QUIET, width: 10 }}>{expanded ? '▾' : '▸'}</span> : <span style={{ width: 10 }} />}<StatusDot status={goal.status} /><span style={{ flex: 1 }}><span style={{ fontSize: 13, fontWeight: goal.kind === 'vision' || goal.kind === 'domain' ? 600 : 500 }}>{goal.kind === 'domain' ? goal.title.toUpperCase() : goal.title}</span><span style={{ marginLeft: 8, fontSize: 10.5, color: TEXT_QUIET }}>{STATUS_LABEL[goal.status]}{goal.priority !== 'medium' ? ` · ${goal.priority}` : ''}</span>{goal.description && <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 2 }}>{goal.description}</div>}{progress && <div style={{ fontSize: 11, color: TEXT_QUIET }}>{progress}</div>}</span></button>{expanded && children.map((child) => <GoalNode key={child.id} goal={child} depth={depth + 1} byParent={byParent} />)}</div> }
function TreeSection({ title, goals }: { title: string; goals: Goal[] }) { const byParent = useMemo(() => { const map = new Map<string, Goal[]>(); for (const goal of goals) { if (!goal.parentId) continue; const list = map.get(goal.parentId) ?? []; list.push(goal); map.set(goal.parentId, list) } return map }, [goals]); const roots = goals.filter((goal) => !goal.parentId).sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]); if (!roots.length) return null; return <div style={{ marginBottom: 20 }}><div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', color: TEXT_QUIET, marginBottom: 6 }}>{title.toUpperCase()}</div>{roots.map((goal) => <GoalNode key={goal.id} goal={goal} depth={0} byParent={byParent} />)}</div> }

export default function DirectionPage({ workspaceId }: { workspaceId: string }) {
  const { data, loading, refetch } = useDirectionData(workspaceId); const [seeding, setSeeding] = useState(false)
  async function handleSeed() { setSeeding(true); try { const { session } = await getSession(); if (!session) return; await fetch('/api/founder/goals/seed', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` } }); await refetch() } finally { setSeeding(false) } }
  const vision = data?.operatorGoals.find((goal) => goal.kind === 'vision'); const domains = data?.operatorGoals.filter((goal) => goal.kind === 'domain') ?? []
  const activeFocus = useMemo(() => { const all = [...(data?.operatorGoals ?? []), ...(data?.workspaceGoals ?? [])]; return all.filter((goal) => goal.status === 'active' && (goal.kind === 'objective' || goal.kind === 'goal' || goal.kind === 'initiative')).sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]).slice(0, 8) }, [data])
  if (loading) return <div style={{ flex: 1, padding: '28px 32px 60px' }}><CayeLoadingPulse label="Loading direction…" /></div>
  if (!data || (!data.operatorGoals.length && !data.workspaceGoals.length)) return <div style={{ flex: 1, padding: '60px 32px', textAlign: 'center' }}><div style={{ color: TEXT }}>No direction set yet</div><button type="button" onClick={handleSeed} disabled={seeding} style={{ marginTop: 20, color: AQUA }}>{seeding ? 'Seeding…' : 'Add starter goals'}</button></div>
  return <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '28px 32px 110px' }}><div style={{ width: '100%', maxWidth: 1180, margin: '0 auto' }}>
    {vision && <div style={{ marginBottom: 22 }}><div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em', color: TEXT_QUIET, marginBottom: 6 }}>DIRECTION</div><div style={{ fontSize: 17, fontWeight: 600, color: TEXT }}>{vision.title}</div>{vision.description && <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginTop: 6, lineHeight: 1.5, maxWidth: 760 }}>{vision.description}</div>}</div>}
    {domains.length > 0 && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>{domains.map((domain) => <div key={domain.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999, ...glass(0.04) }}><StatusDot status={domain.status} /><span style={{ fontSize: 11.5, fontWeight: 600, color: TEXT }}>{domain.title.toUpperCase()}</span><span style={{ fontSize: 10.5, color: TEXT_QUIET }}>({STATUS_LABEL[domain.status]})</span></div>)}</div>}
    <AutonomyStatus workspaceId={workspaceId} />
    <IntelligenceSection />
    {activeFocus.length > 0 && <section style={{ marginBottom: 30 }}><div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.055em', color: TEXT_QUIET, marginBottom: 8 }}>WHAT THIS AUTONOMY IS FOR</div>{activeFocus.map((goal) => <div key={goal.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 2px', fontSize: 13, color: TEXT }}><span style={{ color: AQUA }}>→</span>{goal.title}</div>)}</section>}
    <CapabilitiesSection capabilities={data.capabilities} /><TreeSection title="Operator direction" goals={data.operatorGoals} /><TreeSection title="This workspace" goals={data.workspaceGoals} />
  </div></div>
}
