import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { createServiceClient } from '@/lib/supabase-server'
import { recordRecommendationDecision, type RecommendationDecision } from '@/lib/recommendations/decisions'

type DecisionAction = 'approve' | 'reject' | 'defer'

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function founderCanDecide(requiredAuthority: unknown): boolean {
  const authority = objectValue(requiredAuthority)
  const principalType = stringValue(authority.principalType) ?? stringValue(authority.principal_type)
  const resolvedBy = stringValue(authority.resolvedBy) ?? stringValue(authority.resolved_by)
  return principalType === 'personal' && resolvedBy !== 'unresolved'
}

function canonicalDecision(action: DecisionAction): RecommendationDecision {
  if (action === 'approve') return 'accepted'
  if (action === 'reject') return 'rejected'
  return 'deferred'
}

export async function POST(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json().catch(() => null) as {
    workspaceId?: string
    recommendationId?: string
    recommendationFingerprint?: string
    action?: DecisionAction
  } | null

  if (!body?.workspaceId || !body.recommendationId || !body.recommendationFingerprint) {
    return NextResponse.json({ error: 'workspaceId, recommendationId, and recommendationFingerprint are required' }, { status: 400 })
  }
  if (!['approve', 'reject', 'defer'].includes(body.action ?? '')) {
    return NextResponse.json({ error: 'action must be approve, reject, or defer' }, { status: 400 })
  }

  const db = createServiceClient()
  const { data: recommendation, error: recommendationError } = await db
    .from('caye_recommendations')
    .select('id,fingerprint,status,scope,workspace_id,superseded_at,required_authority')
    .eq('id', body.recommendationId)
    .maybeSingle()

  if (recommendationError) return NextResponse.json({ error: 'Could not load current recommendation state' }, { status: 500 })
  if (!recommendation || recommendation.superseded_at || recommendation.status === 'superseded' || recommendation.status === 'withdrawn') {
    return NextResponse.json({ error: 'That recommendation is no longer current. Refresh Direction before deciding.' }, { status: 409 })
  }
  if (recommendation.scope === 'workspace' && recommendation.workspace_id !== body.workspaceId) {
    return NextResponse.json({ error: 'Recommendation does not belong to this workspace' }, { status: 404 })
  }
  if (recommendation.fingerprint !== body.recommendationFingerprint) {
    return NextResponse.json({ error: 'That recommendation changed. Refresh Direction before deciding.' }, { status: 409 })
  }
  if (recommendation.status !== 'proposed') {
    return NextResponse.json({ error: 'That recommendation already has a current decision. Refresh Direction.' }, { status: 409 })
  }
  if (!founderCanDecide(recommendation.required_authority)) {
    return NextResponse.json({ error: 'This recommendation is not assigned to founder judgment. Nothing was changed.' }, { status: 409 })
  }

  const { data: existingDecision, error: existingDecisionError } = await db
    .from('caye_recommendation_decisions')
    .select('id,decision,recommendation_fingerprint')
    .eq('recommendation_id', recommendation.id)
    .eq('recommendation_fingerprint', recommendation.fingerprint)
    .order('decided_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingDecisionError) return NextResponse.json({ error: 'Could not load current decision state' }, { status: 500 })
  if (existingDecision) {
    return NextResponse.json({ error: 'That recommendation was already decided. Refresh Direction.' }, { status: 409 })
  }

  const action = body.action as DecisionAction
  try {
    const decision = await recordRecommendationDecision({
      recommendationId: recommendation.id,
      decision: canonicalDecision(action),
      actorKind: 'founder',
      actorId: user.id,
      workspaceId: recommendation.scope === 'workspace' ? recommendation.workspace_id : null,
      idempotencyKey: `direction:${recommendation.id}:${recommendation.fingerprint}:${action}:${user.id}`,
      authorityProvenance: {
        source: 'founder_direction',
        authenticatedFounderUserId: user.id,
        requiredAuthority: recommendation.required_authority,
        recommendationFingerprint: recommendation.fingerprint,
      },
    })
    return NextResponse.json({ ok: true, decision, action })
  } catch (error) {
    console.error('[recommendation-decision] canonical write failed', error)
    return NextResponse.json({ error: 'Decision was not recorded' }, { status: 500 })
  }
}
