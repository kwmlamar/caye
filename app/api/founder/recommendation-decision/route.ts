import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { resolveFounderOperator } from '@/lib/operator-identity'
import { createServiceClient } from '@/lib/supabase-server'
import { recordBusinessDecision } from '@/lib/caye-agent/tools/write-low/record-business-decision'

type DecisionAction = 'approve' | 'reject' | 'defer'

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function linkedRecommendation(evidence: unknown) {
  const value = objectValue(evidence)
  return {
    id: stringValue(value.recommendationId) ?? stringValue(value.recommendation_id),
    fingerprint: stringValue(value.recommendationFingerprint) ?? stringValue(value.recommendation_fingerprint),
  }
}

export async function POST(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = await req.json().catch(() => null) as {
    workspaceId?: string
    recommendationId?: string
    recommendationFingerprint?: string
    decisionId?: string
    action?: DecisionAction
  } | null

  if (!body?.workspaceId || !body.recommendationId || !body.recommendationFingerprint || !body.decisionId) {
    return NextResponse.json({ error: 'workspaceId, recommendationId, recommendationFingerprint, and decisionId are required' }, { status: 400 })
  }
  if (!['approve', 'reject', 'defer'].includes(body.action ?? '')) {
    return NextResponse.json({ error: 'action must be approve, reject, or defer' }, { status: 400 })
  }

  const db = createServiceClient()
  const { data: recommendation, error: recommendationError } = await db
    .from('caye_recommendations')
    .select('id,fingerprint,status,scope,workspace_id,superseded_at')
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

  const { data: decision, error: decisionError } = await db
    .from('caye_owner_attention')
    .select('id,subject_type,status,decided_at,blocked_on_operator,decision_evidence')
    .eq('id', body.decisionId)
    .eq('workspace_id', body.workspaceId)
    .eq('subject_type', 'decision')
    .maybeSingle()

  if (decisionError) return NextResponse.json({ error: 'Could not load current decision state' }, { status: 500 })
  if (!decision) return NextResponse.json({ error: 'That decision no longer exists' }, { status: 404 })

  const link = linkedRecommendation(decision.decision_evidence)
  if (link.id !== recommendation.id || link.fingerprint !== recommendation.fingerprint) {
    return NextResponse.json({ error: 'That decision belongs to an older recommendation version. Refresh Direction before deciding.' }, { status: 409 })
  }
  if (decision.decided_at || !['open', 'acknowledged'].includes(decision.status) || decision.blocked_on_operator === false) {
    return NextResponse.json({ error: 'That decision is no longer waiting on you. Refresh Direction.' }, { status: 409 })
  }

  const operator = await resolveFounderOperator(db, body.workspaceId)
  if (!operator) {
    return NextResponse.json({ error: 'Founder decision identity is unavailable for this workspace; nothing was changed.' }, { status: 409 })
  }

  const action = body.action as DecisionAction
  const result = await recordBusinessDecision.execute(
    { decision_id: decision.id, decision: action },
    {
      workspaceId: body.workspaceId,
      callerRole: 'founder',
      operatorId: operator.id,
      requestId: randomUUID(),
      origin: 'chat',
      channel: 'dashboard',
    }
  )

  if (!result.ok) {
    const status = result.status === 'NOT_FOUND' ? 404 : result.status === 'CONFLICT' || result.status === 'NEEDS_HUMAN' ? 409 : 500
    return NextResponse.json({ error: result.error ?? 'Decision was not recorded' }, { status })
  }

  return NextResponse.json({ ok: true, decisionId: decision.id, action })
}
