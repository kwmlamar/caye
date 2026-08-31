import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { createServiceClient } from '@/lib/supabase-server'

type ResearchItem = {
  title: string
  detail: string | null
  at: string | null
  status: string
}

type BeliefChange = {
  claim: string
  rationale: string
  priorConfidence: number | null
  revisedConfidence: number
  at: string
}

type SelfImprovementItem = {
  task: string
  status: string
  testsPassed: boolean | null
  buildPassed: boolean | null
  commitSha: string | null
  at: string
  error: string | null
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

  const db = createServiceClient()
  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [runningCycles, runningRuns, desks, revisions, attention, coding] = await Promise.all([
    db.from('research_desk_cycles')
      .select('status,started_at,summary,research_desks!inner(desk_key,domain,standing_mission)')
      .eq('status', 'running')
      .order('started_at', { ascending: false })
      .limit(6),
    db.from('research_runs')
      .select('status,trigger_source,created_at,started_at,research_questions!inner(question)')
      .in('status', ['queued', 'claimed', 'running'])
      .order('created_at', { ascending: false })
      .limit(8),
    db.from('research_desks')
      .select('desk_key,domain,standing_mission,next_scheduled_investigation,last_successful_research,status,workspace_id')
      .eq('status', 'active')
      .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
      .order('next_scheduled_investigation', { ascending: true })
      .limit(12),
    db.from('intelligence_belief_revisions')
      .select('prior_confidence,revised_confidence,rationale,created_at,intelligence_items!inner(canonical_claim,scope,workspace_id)')
      .gte('created_at', sevenDaysAgo)
      .order('created_at', { ascending: false })
      .limit(12),
    db.from('caye_owner_attention')
      .select('title,priority,status,next_action,required_authority,blocked_on_operator,last_changed_at')
      .eq('workspace_id', workspaceId)
      .in('status', ['open', 'acknowledged'])
      .order('last_changed_at', { ascending: false })
      .limit(12),
    db.from('caye_coding_sessions')
      .select('task,status,final_commit_sha,gate_test_passed,gate_build_passed,error,created_at,finished_at')
      .eq('requested_by', user.id)
      .order('created_at', { ascending: false })
      .limit(8),
  ])

  const firstError = [runningCycles, runningRuns, desks, revisions, attention, coding].find((result) => result.error)?.error
  if (firstError) {
    console.error('[autonomy-status] read failed', firstError)
    return NextResponse.json({ error: 'Failed to load autonomy status' }, { status: 500 })
  }

  const cycleItems: ResearchItem[] = (runningCycles.data ?? []).map((row: any) => {
    const desk = Array.isArray(row.research_desks) ? row.research_desks[0] : row.research_desks
    return {
      title: cleanText(desk?.desk_key)?.replace(/-/g, ' ') ?? 'Research investigation',
      detail: cleanText(row.summary) ?? cleanText(desk?.standing_mission),
      at: row.started_at ?? null,
      status: row.status,
    }
  })

  const runItems: ResearchItem[] = (runningRuns.data ?? []).map((row: any) => {
    const question = Array.isArray(row.research_questions) ? row.research_questions[0] : row.research_questions
    return {
      title: cleanText(question?.question) ?? 'Research question',
      detail: cleanText(row.trigger_source)?.replace(/-/g, ' ') ?? null,
      at: row.started_at ?? row.created_at ?? null,
      status: row.status,
    }
  })

  const seenResearch = new Set<string>()
  const investigating = [...cycleItems, ...runItems].filter((item) => {
    const key = item.title.toLowerCase()
    if (seenResearch.has(key)) return false
    seenResearch.add(key)
    return true
  }).slice(0, 8)

  const monitoring: ResearchItem[] = (desks.data ?? []).map((row: any) => ({
    title: cleanText(row.desk_key)?.replace(/-/g, ' ') ?? cleanText(row.domain)?.replace(/_/g, ' ') ?? 'Research desk',
    detail: cleanText(row.standing_mission),
    at: row.next_scheduled_investigation ?? row.last_successful_research ?? null,
    status: 'monitoring',
  }))

  const beliefChanges: BeliefChange[] = (revisions.data ?? [])
    .filter((row: any) => {
      const item = Array.isArray(row.intelligence_items) ? row.intelligence_items[0] : row.intelligence_items
      return item && (item.scope === 'operator' || item.workspace_id === workspaceId)
    })
    .map((row: any) => {
      const item = Array.isArray(row.intelligence_items) ? row.intelligence_items[0] : row.intelligence_items
      return {
        claim: cleanText(item?.canonical_claim) ?? 'Updated belief',
        rationale: cleanText(row.rationale) ?? 'New evidence changed confidence.',
        priorConfidence: row.prior_confidence == null ? null : Number(row.prior_confidence),
        revisedConfidence: Number(row.revised_confidence),
        at: row.created_at,
      }
    })

  const needsYou = (attention.data ?? []).filter((row: any) => row.blocked_on_operator !== false).map((row: any) => ({
    title: cleanText(row.title) ?? 'Founder judgment needed',
    detail: cleanText(row.next_action),
    priority: row.priority,
    authority: cleanText(row.required_authority),
    at: row.last_changed_at,
  }))

  const selfImprovement: SelfImprovementItem[] = (coding.data ?? []).map((row: any) => ({
    task: cleanText(row.task) ?? 'Code improvement',
    status: row.status,
    testsPassed: row.gate_test_passed,
    buildPassed: row.gate_build_passed,
    commitSha: cleanText(row.final_commit_sha),
    at: row.finished_at ?? row.created_at,
    error: cleanText(row.error),
  }))

  const activeCoding = selfImprovement.filter((item) => ['queued', 'starting', 'running', 'testing', 'building'].includes(item.status)).length
  const completedCoding = selfImprovement.filter((item) => ['completed', 'succeeded', 'merged'].includes(item.status)).length

  return NextResponse.json({
    generatedAt: now.toISOString(),
    summary: {
      investigating: investigating.length,
      monitoring: monitoring.length,
      beliefChanges7d: beliefChanges.length,
      needsYou: needsYou.length,
      selfImprovementActive: activeCoding,
      selfImprovementCompleted: completedCoding,
    },
    investigating,
    monitoring,
    beliefChanges,
    selfImprovement,
    needsYou,
  })
}
