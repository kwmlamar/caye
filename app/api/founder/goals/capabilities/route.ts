import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { createServiceClient } from '@/lib/supabase-server'

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const supabase = createServiceClient()
  const { data: rows, error } = await supabase
    .from('caye_goal_capabilities')
    .select(`
      goal_id,
      capability_key,
      maturity_level,
      maturity_label,
      current_state,
      next_state,
      blockers,
      last_assessed_at,
      caye_goals!inner(id,title,description,status,priority,parent_id),
      caye_goal_capability_evidence(id,evidence_type,evidence_ref,summary,confidence,observed_at),
      caye_goal_capability_assessments(id,maturity_level,maturity_label,rationale,evidence_refs,assessed_by,assessed_at)
    `)
    .order('maturity_level', { ascending: false })

  if (error) {
    console.error('[founder/capabilities] read failed:', error.message)
    return NextResponse.json({ error: 'Failed to load capabilities' }, { status: 500 })
  }

  const capabilities = (rows ?? []).map((row: any) => ({
    goalId: row.goal_id,
    key: row.capability_key,
    title: row.caye_goals?.title ?? row.capability_key,
    description: row.caye_goals?.description ?? null,
    status: row.caye_goals?.status ?? 'future',
    priority: row.caye_goals?.priority ?? 'medium',
    parentId: row.caye_goals?.parent_id ?? null,
    maturityLevel: row.maturity_level,
    maturityLabel: row.maturity_label,
    currentState: row.current_state,
    nextState: row.next_state,
    blockers: row.blockers ?? [],
    lastAssessedAt: row.last_assessed_at,
    evidence: row.caye_goal_capability_evidence ?? [],
    assessments: (row.caye_goal_capability_assessments ?? []).sort(
      (a: any, b: any) => new Date(b.assessed_at).getTime() - new Date(a.assessed_at).getTime()
    ),
  }))

  return NextResponse.json({ capabilities })
}
