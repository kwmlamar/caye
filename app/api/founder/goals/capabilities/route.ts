import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/founder'
import { createServiceClient } from '@/lib/supabase-server'
import { hasDefensibleCapabilityProgress } from '@/lib/goals/operating-intelligence-capabilities'
import { capabilityCoverage } from '@/lib/capabilities/control-plane'

export async function GET(req: NextRequest) {
  const user = await requireFounder(req)
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const supabase = createServiceClient()
  const [capabilityResult, evidenceResult, dependencyResult, linkResult] = await Promise.all([
    supabase
      .from('caye_operating_intelligence_capabilities')
      .select('id,capability_key,title,description,maturity_status,limitations,progress_percent,progress_evidence_id,last_verified_at,sort_order')
      .order('sort_order', { ascending: true }),
    supabase
      .from('caye_operating_intelligence_capability_evidence')
      .select('id,capability_id,evidence_kind,source_ref,summary,verifies_capability,confidence,observed_at,verified_at')
      .order('observed_at', { ascending: false }),
    supabase
      .from('caye_operating_intelligence_capability_dependencies')
      .select('capability_id,depends_on_capability_id,note'),
    supabase
      .from('caye_operating_intelligence_capability_goal_links')
      .select('capability_id,goal_id,relationship'),
  ])

  if (capabilityResult.error) {
    console.error('[founder/capabilities] capability read failed:', capabilityResult.error.message)
    return NextResponse.json({ error: 'Failed to load capabilities' }, { status: 500 })
  }
  if (evidenceResult.error || dependencyResult.error || linkResult.error) {
    console.error('[founder/capabilities] related data read failed:', {
      evidence: evidenceResult.error?.message,
      dependencies: dependencyResult.error?.message,
      links: linkResult.error?.message,
    })
    return NextResponse.json({ error: 'Failed to load capability evidence' }, { status: 500 })
  }

  const rows = capabilityResult.data ?? []
  const evidence = evidenceResult.data ?? []
  const dependencies = dependencyResult.data ?? []
  const links = linkResult.data ?? []
  const goalIds = [...new Set(links.map((link) => link.goal_id))]
  const { data: goals, error: goalsError } = goalIds.length
    ? await supabase
        .from('caye_goals')
        .select('id,title,kind,status,parent_id')
        .in('id', goalIds)
        .is('superseded_at', null)
    : { data: [], error: null }

  if (goalsError) {
    console.error('[founder/capabilities] linked goal read failed:', goalsError.message)
    return NextResponse.json({ error: 'Failed to load capability links' }, { status: 500 })
  }

  const capabilityById = new Map(rows.map((row) => [row.id, row]))
  const goalById = new Map((goals ?? []).map((goal) => [goal.id, goal]))

  const capabilities = rows.map((row) => {
    const progressClaim = {
      progressPercent: row.progress_percent === null ? null : Number(row.progress_percent),
      progressEvidenceId: row.progress_evidence_id,
      lastVerifiedAt: row.last_verified_at,
    }
    const rowEvidence = evidence.filter((item) => item.capability_id === row.id)
    const rowLinks = links
      .filter((link) => link.capability_id === row.id)
      .map((link) => ({ relationship: link.relationship, goal: goalById.get(link.goal_id) ?? null }))
      .filter((link) => link.goal)

    return {
      id: row.id,
      key: row.capability_key,
      title: row.title,
      description: row.description,
      maturityStatus: row.maturity_status,
      limitations: Array.isArray(row.limitations) ? row.limitations : [],
      progressPercent: hasDefensibleCapabilityProgress(progressClaim) ? progressClaim.progressPercent : null,
      lastVerifiedAt: row.last_verified_at,
      evidence: rowEvidence,
      dependencies: dependencies
        .filter((dependency) => dependency.capability_id === row.id)
        .map((dependency) => ({
          note: dependency.note,
          capability: capabilityById.get(dependency.depends_on_capability_id) ?? null,
        }))
        .filter((dependency) => dependency.capability),
      relatedObjectives: rowLinks.filter((link) => link.goal?.kind === 'objective'),
      relatedInitiatives: rowLinks.filter((link) => link.goal?.kind === 'initiative'),
    }
  })

  // Durable roadmap maturity remains evidence-backed in the Direction tables.
  // Runtime coverage is derived independently from the actual model-facing
  // registry, so Direction can distinguish "roadmap capability" from "Caye can
  // invoke this today" without inventing progress percentages from tool counts.
  return NextResponse.json({ capabilities, controlPlaneCoverage: capabilityCoverage() })
}
