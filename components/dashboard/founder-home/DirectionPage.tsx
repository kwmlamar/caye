'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getSession } from '@/lib/supabase'
import { CayeLoadingPulse } from './CayeLoadingPulse'
import { AQUA, EMERALD, GOLD, ROSE, TEXT, TEXT_MUTED, TEXT_QUIET, glass } from '../surface'

/**
 * Direction — the founder's view of Caye's goal substrate (lib/goals/*,
 * /api/founder/goals). Deliberately NOT a project-management screen: no
 * kanban, no fake percentage-complete bars, no due-date grid. It shows the
 * same shape the product spec asks for — a vision statement, domain
 * status, a short "current focus" list, and a drillable tree — because
 * that's what answers "what is Caye trying to accomplish, why, and what's
 * she doing about it right now," not a backlog.
 *
 * Founder/admin scope, not customer scope — the customer-dashboard
 * anti-patterns (no settings pages, no config wizards) do not apply here;
 * see Products/Caye/CLAUDE.md.
 */

type GoalKind = 'vision' | 'domain' | 'objective' | 'goal' | 'initiative'
type GoalStatus = 'active' | 'future' | 'blocked' | 'paused' | 'completed' | 'abandoned'
type GoalPriority = 'low' | 'medium' | 'high' | 'critical'

interface ActivationCondition {
  metric_key: string
  comparator: string
  threshold: number
  sustained_days?: number
  note?: string
}

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
  targetDate: string | null
  completionCriteria: string | null
  activationConditions: ActivationCondition[] | null
  rationale: string | null
  createdByKind: string
  createdByLabel: string | null
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
  active: 'active', future: 'future', blocked: 'blocked', paused: 'paused',
  completed: 'completed', abandoned: 'superseded',
}
const PRIORITY_WEIGHT: Record<GoalPriority, number> = { critical: 4, high: 3, medium: 2, low: 1 }

function useDirectionData(workspaceId: string) {
  const [data, setData] = useState<{ operatorGoals: Goal[]; workspaceGoals: Goal[] } | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { session } = await getSession()
    if (!session) { setLoading(false); return }
    const res = await fetch(`/api/founder/goals?workspaceId=${workspaceId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    if (!res.ok) { setLoading(false); return }
    const json = await res.json()
    setData({ operatorGoals: json.operatorGoals ?? [], workspaceGoals: json.workspaceGoals ?? [] })
    setLoading(false)
  }, [workspaceId])

  useEffect(() => { setLoading(true); load() }, [load])

  return { data, loading, refetch: load }
}

function StatusDot({ status }: { status: GoalStatus }) {
  return (
    <span
      aria-hidden
      style={{
        width: 6, height: 6, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
        background: STATUS_COLOR[status],
        boxShadow: status === 'active' ? `0 0 6px ${STATUS_COLOR[status]}99` : undefined,
      }}
    />
  )
}

/** Recursive tree node. byParent is looked up fresh at each level (passed
 *  down as a plain prop, not shared mutable state) so multiple independent
 *  TreeSections can render at once without stepping on each other. */
function GoalNode({ goal, depth, byParent }: { goal: Goal; depth: number; byParent: Map<string, Goal[]> }) {
  const children = byParent.get(goal.id) ?? []
  const [expanded, setExpanded] = useState(depth < 1)
  const progress =
    goal.targetValue !== null && goal.currentValue !== null && goal.unit
      ? `${goal.currentValue} / ${goal.targetValue} ${goal.unit}`
      : null

  return (
    <div style={{ marginLeft: depth * 16 }}>
      <button
        type="button"
        onClick={() => children.length > 0 && setExpanded((e) => !e)}
        style={{
          width: '100%', display: 'flex', alignItems: 'flex-start', gap: 8, textAlign: 'left',
          padding: '7px 8px', border: 0, borderRadius: 8, cursor: children.length > 0 ? 'pointer' : 'default',
          background: 'transparent', color: TEXT,
        }}
      >
        {children.length > 0 && (
          <span aria-hidden style={{ color: TEXT_QUIET, fontSize: 10, marginTop: 3, width: 10, flexShrink: 0 }}>
            {expanded ? '▾' : '▸'}
          </span>
        )}
        {children.length === 0 && <span style={{ width: 10, flexShrink: 0 }} />}
        <StatusDot status={goal.status} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: goal.kind === 'vision' || goal.kind === 'domain' ? 600 : 500 }}>
            {goal.kind === 'domain' ? goal.title.toUpperCase() : goal.title}
          </span>
          <span style={{ marginLeft: 8, fontSize: 10.5, color: TEXT_QUIET }}>
            {STATUS_LABEL[goal.status]}
            {goal.priority !== 'medium' ? ` · ${goal.priority}` : ''}
          </span>
          {goal.description && (
            <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 2 }}>{goal.description}</div>
          )}
          {progress && <div style={{ fontSize: 11, color: TEXT_QUIET, marginTop: 2 }}>{progress}</div>}
          {!progress && goal.completionCriteria && (
            <div style={{ fontSize: 11, color: TEXT_QUIET, marginTop: 2, fontStyle: 'italic' }}>
              Done when: {goal.completionCriteria}
            </div>
          )}
          {goal.activationConditions && goal.activationConditions.length > 0 && (
            <div style={{ fontSize: 10.5, color: TEXT_QUIET, marginTop: 3 }}>
              Activates when: {goal.activationConditions.map((c) => c.note ?? `${c.metric_key} ${c.comparator} ${c.threshold}`).join('; ')}
            </div>
          )}
        </span>
      </button>
      {expanded && children.length > 0 && (
        <div>
          {children.map((child) => (
            <GoalNode key={child.id} goal={child} depth={depth + 1} byParent={byParent} />
          ))}
        </div>
      )}
    </div>
  )
}

function TreeSection({ title, goals }: { title: string; goals: Goal[] }) {
  const byParent = useMemo(() => {
    const map = new Map<string, Goal[]>()
    for (const g of goals) {
      if (!g.parentId) continue
      const list = map.get(g.parentId) ?? []
      list.push(g)
      map.set(g.parentId, list)
    }
    for (const list of map.values()) list.sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority])
    return map
  }, [goals])

  const roots = goals.filter((g) => !g.parentId).sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority])
  if (roots.length === 0) return null

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', color: TEXT_QUIET, marginBottom: 6 }}>
        {title.toUpperCase()}
      </div>
      {roots.map((g) => (
        <GoalNode key={g.id} goal={g} depth={0} byParent={byParent} />
      ))}
    </div>
  )
}

function EmptyState({ onSeed, seeding }: { onSeed: () => void; seeding: boolean }) {
  return (
    <div style={{ maxWidth: 460, margin: '60px auto', textAlign: 'center' }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: TEXT, marginBottom: 8 }}>No direction set yet</div>
      <div style={{ fontSize: 13, color: TEXT_MUTED, marginBottom: 20, lineHeight: 1.5 }}>
        Caye has no durable objectives to reason against yet. Seed the starter shape — a vision and the
        Business/Personal/Research domains — or add your own from scratch via the API.
      </div>
      <button
        type="button"
        onClick={onSeed}
        disabled={seeding}
        style={{
          padding: '9px 18px', borderRadius: 10, border: 0, cursor: seeding ? 'default' : 'pointer',
          background: 'rgba(78,190,206,0.14)', color: AQUA, font: '600 12.5px inherit', opacity: seeding ? 0.6 : 1,
        }}
      >
        {seeding ? 'Seeding…' : 'Seed starter direction'}
      </button>
    </div>
  )
}

export default function DirectionPage({ workspaceId }: { workspaceId: string }) {
  const { data, loading, refetch } = useDirectionData(workspaceId)
  const [seeding, setSeeding] = useState(false)

  async function handleSeed() {
    setSeeding(true)
    try {
      const { session } = await getSession()
      if (!session) return
      await fetch('/api/founder/goals/seed', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      await refetch()
    } finally {
      setSeeding(false)
    }
  }

  const vision = data?.operatorGoals.find((g) => g.kind === 'vision')
  const domains = data?.operatorGoals.filter((g) => g.kind === 'domain') ?? []
  const activeFocus = useMemo(() => {
    const all = [...(data?.operatorGoals ?? []), ...(data?.workspaceGoals ?? [])]
    return all
      .filter((g) => g.status === 'active' && (g.kind === 'objective' || g.kind === 'goal' || g.kind === 'initiative'))
      .sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority])
      .slice(0, 8)
  }, [data])

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '28px 32px 60px' }}>
      {loading ? (
        <CayeLoadingPulse label="Loading direction…" />
      ) : !data || (data.operatorGoals.length === 0 && data.workspaceGoals.length === 0) ? (
        <EmptyState onSeed={handleSeed} seeding={seeding} />
      ) : (
        <div style={{ maxWidth: 720 }}>
          {vision && (
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em', color: TEXT_QUIET, marginBottom: 6 }}>
                DIRECTION
              </div>
              <div style={{ fontSize: 17, fontWeight: 600, color: TEXT, lineHeight: 1.35 }}>{vision.title}</div>
              {vision.description && (
                <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginTop: 6, lineHeight: 1.5, maxWidth: 600 }}>
                  {vision.description}
                </div>
              )}
            </div>
          )}

          {domains.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 26 }}>
              {domains.map((d) => (
                <div
                  key={d.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999,
                    ...glass(0.04),
                  }}
                >
                  <StatusDot status={d.status} />
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: TEXT }}>{d.title.toUpperCase()}</span>
                  <span style={{ fontSize: 10.5, color: TEXT_QUIET }}>({STATUS_LABEL[d.status]})</span>
                </div>
              ))}
            </div>
          )}

          {activeFocus.length > 0 && (
            <div style={{ marginBottom: 30 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', color: TEXT_QUIET, marginBottom: 8 }}>
                CURRENT FOCUS
              </div>
              {activeFocus.map((g) => (
                <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 2px', fontSize: 13, color: TEXT }}>
                  <span aria-hidden style={{ color: AQUA }}>→</span>
                  {g.title}
                  {g.scope === 'workspace' && (
                    <span style={{ fontSize: 10, color: TEXT_QUIET, ...glass(0.05), padding: '1px 6px', borderRadius: 999 }}>
                      this workspace
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <TreeSection title="Operator direction" goals={data.operatorGoals} />
          <TreeSection title="This workspace" goals={data.workspaceGoals} />
        </div>
      )}
    </div>
  )
}
