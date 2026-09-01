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

type RecommendationEvidence = {
  statement: string
  confidence: number | null
  sourceQuality: string | null
  status: string
}

type RecommendationAuthority = {
  principalType: string | null
  principalRef: string | null
  resolvedBy: string | null
  label: string
}

type RecommendationDecision = {
  id: string
  state: 'pending' | 'approved' | 'rejected' | 'deferred' | 'stale'
  canRespond: boolean
  stale: boolean
  requestedAt: string | null
  expiresAt: string | null
}

type RecommendationItem = {
  id: string
  fingerprint: string
  status: string
  title: string
  action: string
  why: string
  affectedGoal: string
  confidence: number
  expectedImpact: string
  urgency: string
  risk: string
  reversibility: string
  authority: RecommendationAuthority
  updatedAt: string
  evidence: RecommendationEvidence[]
  decision: RecommendationDecision | null
  executionState: string | null
  authorityDisposition: string | null
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, 'internal record')
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function recommendationLink(evidence: unknown): { id: string | null; fingerprint: string | null; executionState: string | null; authorityDisposition: string | null } {
  const value = objectValue(evidence)
  return {
    id: stringValue(value.recommendationId) ?? stringValue(value.recommendation_id),
    fingerprint: stringValue(value.recommendationFingerprint) ?? stringValue(value.recommendation_fingerprint),
    executionState: stringValue(value.recommendationExecutionState) ?? stringValue(value.execution_state),
    authorityDisposition: stringValue(value.recommendationAuthorityDisposition) ?? stringValue(value.authority_disposition),
  }
}

function decisionState(value: unknown): RecommendationDecision['state'] {
  const normalized = stringValue(value)?.toLowerCase()
  if (normalized === 'approve' || normalized === 'approved' || normalized === 'accept' || normalized === 'accepted') return 'approved'
  if (normalized === 'reject' || normalized === 'rejected' || normalized === 'deny' || normalized === 'denied') return 'rejected'
  if (normalized === 'defer' || normalized === 'deferred') return 'deferred'
  return 'pending'
}

function authorityLabel(value: unknown): RecommendationAuthority {
  const authority = objectValue(value)
  const principalType = stringValue(authority.principalType) ?? stringValue(authority.principal_type)
  const principalRef = stringValue(authority.principalRef) ?? stringValue(authority.principal_ref)
  const resolvedBy = stringValue(authority.resolvedBy) ?? stringValue(authority.resolved_by)
  const label = principalType === 'personal'
    ? 'Founder judgment'
    : principalType === 'workspace'
      ? 'Workspace authority'
      : principalType === 'business'
        ? 'Business authority'
        : resolvedBy === 'unresolved'
          ? 'Authority unresolved'
          : principalRef ?? 'Authority required'
  return { principalType, principalRef, resolvedBy, label }
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
      .select('id,subject_type,title,priority,status,next_action,required_authority,blocked_on_operator,last_changed_at,decision,decided_at,decision_requested_at,decision_expires_at,decision_evidence')
      .eq('workspace_id', workspaceId)
      .in('status', ['open', 'acknowledged', 'decided'])
      .order('last_changed_at', { ascending: false })
      .limit(30),
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

  const attentionRows = attention.data ?? []
  const decisionRowsByRecommendation = new Map<string, any>()
  for (const row of attentionRows) {
    if (row.subject_type !== 'decision') continue
    const link = recommendationLink(row.decision_evidence)
    if (link.id) decisionRowsByRecommendation.set(link.id, row)
  }

  let recommendationRows: any[] = []
  const recommendationsResult = await db.from('caye_recommendations')
    .select('id,scope,workspace_id,goal_id,title,recommendation,rationale,status,confidence,expected_impact,urgency,reversibility,risk_classification,required_authority,fingerprint,provenance,updated_at,superseded_at,caye_goals!inner(title,status,superseded_at)')
    .or(`workspace_id.eq.${workspaceId},scope.eq.operator`)
    .is('superseded_at', null)
    .in('status', ['proposed', 'accepted', 'deferred'])
    .order('updated_at', { ascending: false })
    .limit(20)

  if (recommendationsResult.error) {
    // Direction is a mission-control read model. A recommendation deployment
    // drift must not erase the existing research/attention surface.
    console.error('[autonomy-status] recommendation read failed', recommendationsResult.error)
  } else {
    recommendationRows = (recommendationsResult.data ?? []).filter((row: any) => {
      const goal = Array.isArray(row.caye_goals) ? row.caye_goals[0] : row.caye_goals
      return goal?.status === 'active' && !goal?.superseded_at
    })
  }

  const evidenceByRecommendation = new Map<string, RecommendationEvidence[]>()
  if (recommendationRows.length > 0) {
    const ids = recommendationRows.map((row) => row.id)
    const evidenceResult = await db.from('caye_recommendation_claims')
      .select('recommendation_id,research_claims!inner(statement,confidence,source_quality,status)')
      .in('recommendation_id', ids)
    if (evidenceResult.error) {
      console.error('[autonomy-status] recommendation evidence read failed', evidenceResult.error)
    } else {
      for (const row of evidenceResult.data ?? []) {
        const claim = Array.isArray((row as any).research_claims) ? (row as any).research_claims[0] : (row as any).research_claims
        if (!claim) continue
        const list = evidenceByRecommendation.get((row as any).recommendation_id) ?? []
        list.push({
          statement: cleanText(claim.statement) ?? 'Evidence claim',
          confidence: claim.confidence == null ? null : Number(claim.confidence),
          sourceQuality: cleanText(claim.source_quality),
          status: cleanText(claim.status) ?? 'current',
        })
        evidenceByRecommendation.set((row as any).recommendation_id, list)
      }
    }
  }

  const recommendations: RecommendationItem[] = recommendationRows.map((row: any) => {
    const goal = Array.isArray(row.caye_goals) ? row.caye_goals[0] : row.caye_goals
    const linkedDecision = decisionRowsByRecommendation.get(row.id)
    const link = recommendationLink(linkedDecision?.decision_evidence)
    const fingerprintMatches = !!linkedDecision && link.fingerprint === row.fingerprint
    const stale = !!linkedDecision && !fingerprintMatches
    const decided = !!linkedDecision?.decided_at
    const state = stale ? 'stale' : decided ? decisionState(linkedDecision.decision) : 'pending'
    const decision: RecommendationDecision | null = linkedDecision ? {
      id: linkedDecision.id,
      state,
      canRespond: !stale && !decided && linkedDecision.blocked_on_operator !== false && ['open', 'acknowledged'].includes(linkedDecision.status),
      stale,
      requestedAt: linkedDecision.decision_requested_at ?? null,
      expiresAt: linkedDecision.decision_expires_at ?? null,
    } : null

    return {
      id: row.id,
      fingerprint: row.fingerprint,
      status: row.status,
      title: cleanText(row.title) ?? 'Recommendation',
      action: cleanText(row.recommendation) ?? 'Review recommendation',
      why: cleanText(row.rationale) ?? 'Grounded in current intelligence.',
      affectedGoal: cleanText(goal?.title) ?? 'Active goal',
      confidence: Number(row.confidence),
      expectedImpact: cleanText(row.expected_impact) ?? 'Not specified',
      urgency: cleanText(row.urgency) ?? 'low',
      risk: cleanText(row.risk_classification) ?? 'low',
      reversibility: cleanText(row.reversibility) ?? 'moderate',
      authority: authorityLabel(row.required_authority),
      updatedAt: row.updated_at,
      evidence: (evidenceByRecommendation.get(row.id) ?? []).slice(0, 6),
      decision,
      executionState: link.executionState,
      authorityDisposition: link.authorityDisposition,
    }
  })

  const recommendationDecisionIds = new Set(
    recommendations.map((item) => item.decision?.id).filter((id): id is string => !!id)
  )
  const needsYou = attentionRows
    .filter((row: any) => row.blocked_on_operator !== false)
    .filter((row: any) => !recommendationDecisionIds.has(row.id))
    .filter((row: any) => ['open', 'acknowledged'].includes(row.status))
    .map((row: any) => ({
      title: cleanText(row.title) ?? 'Founder judgment needed',
      detail: cleanText(row.next_action),
      priority: row.priority,
      authority: cleanText(row.required_authority),
      at: row.last_changed_at,
    }))

  const blockedRecommendations = recommendations.filter((item) => item.decision?.canRespond === true)
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
      needsYou: needsYou.length + blockedRecommendations.length,
      selfImprovementActive: activeCoding,
      selfImprovementCompleted: completedCoding,
    },
    investigating,
    monitoring,
    beliefChanges,
    selfImprovement,
    needsYou,
    recommendations,
  })
}
