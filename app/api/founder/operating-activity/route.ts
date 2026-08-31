import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { createServiceClient } from '@/lib/supabase-server'

type ActivityItem = {
  label: string
  detail?: string | null
  at?: string | null
  tone?: 'neutral' | 'good' | 'warn' | 'attention'
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, 'internal record')
}

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

  const includeAllLearned = req.nextUrl.searchParams.get('allLearned') === '1'
  const db = createServiceClient()
  const now = new Date().toISOString()

  const [runningCycles, intelligence, relations, effects, attention, desks] = await Promise.all([
    db.from('research_desk_cycles')
      .select('status,started_at,research_desks!inner(desk_key,domain,standing_mission)')
      .eq('status', 'running')
      .order('started_at', { ascending: false })
      .limit(3),
    db.from('intelligence_items')
      .select('canonical_claim,topic,domain,epistemic_type,confidence,materiality,created_at,updated_at,scope,workspace_id,status', { count: 'exact' })
      .or(`scope.eq.operator,workspace_id.eq.${workspaceId}`)
      .in('status', ['current', 'contested'])
      .order('updated_at', { ascending: false })
      .limit(includeAllLearned ? 200 : 5),
    db.from('intelligence_relations')
      .select('relation_type,confidence,created_at,from_item:intelligence_items!intelligence_relations_from_item_id_fkey(canonical_claim,scope,workspace_id),to_item:intelligence_items!intelligence_relations_to_item_id_fkey(canonical_claim,scope,workspace_id)')
      .in('relation_type', ['contradicts', 'supersedes'])
      .order('created_at', { ascending: false })
      .limit(8),
    db.from('caye_effect_verifications')
      .select('effect,action_kind,verification_status,verification_reason,verified_at,updated_at')
      .eq('workspace_id', workspaceId)
      .eq('verification_status', 'VERIFIED')
      .order('verified_at', { ascending: false })
      .limit(5),
    db.from('caye_owner_attention')
      .select('title,priority,status,last_notified_summary,next_action,required_authority,blocked_on_operator,updated_at,last_changed_at')
      .eq('workspace_id', workspaceId)
      .in('status', ['open', 'acknowledged'])
      .order('last_changed_at', { ascending: false })
      .limit(5),
    db.from('research_desks')
      .select('desk_key,domain,standing_mission,next_scheduled_investigation,status')
      .eq('status', 'active')
      .gte('next_scheduled_investigation', now)
      .order('next_scheduled_investigation', { ascending: true })
      .limit(5),
  ])

  const firstError = [runningCycles, intelligence, relations, effects, attention, desks].find((result) => result.error)?.error
  if (firstError) {
    console.error('[operating-activity] read failed', firstError)
    return NextResponse.json({ error: 'Failed to load operating activity' }, { status: 500 })
  }

  const researchingNow: ActivityItem[] = (runningCycles.data ?? []).map((row: any) => {
    const desk = Array.isArray(row.research_desks) ? row.research_desks[0] : row.research_desks
    return {
      label: cleanText(desk?.desk_key)?.replace(/-/g, ' ') ?? 'Research investigation',
      detail: cleanText(desk?.standing_mission),
      at: row.started_at,
      tone: 'good',
    }
  })

  const recentlyLearned: ActivityItem[] = (intelligence.data ?? []).map((row: any) => ({
    label: cleanText(row.canonical_claim) ?? 'New intelligence item',
    detail: [cleanText(row.domain)?.replace(/_/g, ' '), cleanText(row.epistemic_type)?.replace(/_/g, ' '), row.confidence == null ? null : `${Math.round(Number(row.confidence) * 100)}% confidence`].filter(Boolean).join(' · '),
    at: row.updated_at ?? row.created_at,
    tone: Number(row.materiality ?? 0) >= 0.7 ? 'good' : 'neutral',
  }))

  const beliefChanges: ActivityItem[] = (relations.data ?? [])
    .filter((row: any) => {
      const from = Array.isArray(row.from_item) ? row.from_item[0] : row.from_item
      const to = Array.isArray(row.to_item) ? row.to_item[0] : row.to_item
      const visible = (item: any) => item && (item.scope === 'operator' || item.workspace_id === workspaceId)
      return visible(from) && visible(to)
    })
    .slice(0, 5)
    .map((row: any) => {
      const from = Array.isArray(row.from_item) ? row.from_item[0] : row.from_item
      const to = Array.isArray(row.to_item) ? row.to_item[0] : row.to_item
      return {
        label: row.relation_type === 'supersedes' ? `Updated belief: ${cleanText(from?.canonical_claim) ?? 'newer evidence'}` : `Contradictory evidence: ${cleanText(from?.canonical_claim) ?? 'new evidence'}`,
        detail: row.relation_type === 'supersedes' ? `Supersedes: ${cleanText(to?.canonical_claim) ?? 'older belief'}` : `Conflicts with: ${cleanText(to?.canonical_claim) ?? 'existing belief'}`,
        at: row.created_at,
        tone: row.relation_type === 'contradicts' ? 'warn' : 'good',
      }
    })

  const actionsTaken: ActivityItem[] = (effects.data ?? []).map((row: any) => ({
    label: cleanText(row.effect) ?? cleanText(row.action_kind)?.replace(/_/g, ' ') ?? 'Verified action',
    detail: cleanText(row.verification_reason) ?? 'Observed state matched the intended effect.',
    at: row.verified_at ?? row.updated_at,
    tone: 'good',
  }))

  const waitingOnHuman: ActivityItem[] = (attention.data ?? []).map((row: any) => ({
    label: cleanText(row.title) ?? 'Human decision needed',
    detail: [cleanText(row.next_action), cleanText(row.required_authority) ? `Authority: ${cleanText(row.required_authority)}` : null].filter(Boolean).join(' · ') || cleanText(row.last_notified_summary),
    at: row.last_changed_at ?? row.updated_at,
    tone: row.priority === 'critical' || row.priority === 'high' ? 'attention' : 'warn',
  }))

  const nextScheduledWork: ActivityItem[] = (desks.data ?? []).map((row: any) => ({
    label: cleanText(row.desk_key)?.replace(/-/g, ' ') ?? 'Research desk',
    detail: cleanText(row.standing_mission),
    at: row.next_scheduled_investigation,
    tone: 'neutral',
  }))

  const lastActivityAt = [
    ...researchingNow, ...recentlyLearned, ...beliefChanges, ...actionsTaken, ...waitingOnHuman,
  ].map((item) => item.at).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null

  const status = researchingNow.length > 0 ? 'working' : nextScheduledWork.length > 0 ? 'scheduled' : 'idle'

  return NextResponse.json({
    status,
    generatedAt: now,
    lastActivityAt,
    sectionTotals: {
      recentlyLearned: intelligence.count ?? recentlyLearned.length,
    },
    sections: {
      researchingNow,
      recentlyLearned,
      beliefChanges,
      actionsTaken,
      waitingOnHuman,
      nextScheduledWork,
    },
  })
}
