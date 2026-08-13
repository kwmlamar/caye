/**
 * GET /api/founder/memory?workspaceId=<uuid>
 *
 * Read-only view over what Caye actually knows about this business —
 * business_facts (advisory knowledge: policies, service details, special
 * handling, logistics), caye_standing_rules (enforced constraints,
 * evaluated deterministically before the model runs), and
 * business_fact_candidates (patterns Caye has noticed repeating across
 * conversations — either still awaiting the owner's confirm/correct/
 * dismiss, or already resolved into a fact, in which case its
 * occurrence_count is the real "learned from N conversations" provenance
 * for that fact). See supabase/migrations/20260625_business_facts.sql,
 * 20260808_caye_standing_rules.sql, and 20260705_business_fact_candidates.sql
 * + 20260807h_fact_candidate_lifecycle.sql.
 *
 * No write path here on purpose, matching ContactsPanel's convention: this
 * is a lens on what Caye already learned via add_business_fact / standing
 * rule creation / the candidate-confirmation flow, not an editor. Teaching
 * Caye something new stays a WhatsApp/Ask-Caye action.
 *
 * Auth: Bearer JWT, checked against FOUNDER_USER_IDS.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient, createServerClient } from '@/lib/supabase-server'
import { isFounderUserId } from '@/lib/founder'

export async function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
  }

  const authHeader = req.headers.get('authorization')
  const accessToken = authHeader?.replace('Bearer ', '')
  if (!accessToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userClient = createServerClient(accessToken)
  const { data: { user } } = await userClient.auth.getUser()
  if (!user || !isFounderUserId(user.id)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const supabase = createServiceClient()

  const [
    { data: facts, error: factsErr },
    { data: rules, error: rulesErr },
    { data: pendingCandidates, error: pendingErr },
    { data: resolvedCandidates, error: resolvedErr },
  ] = await Promise.all([
    supabase
      .from('business_facts')
      .select('id, category, fact, source, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('caye_standing_rules')
      .select('id, trigger_type, match_value, action, route_to, is_active, times_fired, last_fired_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(100),
    // "Needs clarification" — Caye noticed a repeating pattern and
    // proposed it to the owner; genuinely open/uncertain until answered.
    // NOT a fabricated conflict — this is a real lifecycle state.
    supabase
      .from('business_fact_candidates')
      .select('id, sample_text, category_guess, occurrence_count, first_seen_at, proposed_at')
      .eq('workspace_id', workspaceId)
      .eq('status', 'proposed')
      .order('proposed_at', { ascending: false })
      .limit(50),
    // Resolved candidates carry the real occurrence_count for whichever
    // business_facts row they produced — the provenance behind "learned
    // from N conversations" on a candidate-confirmed fact.
    supabase
      .from('business_fact_candidates')
      .select('resolved_fact_id, occurrence_count')
      .eq('workspace_id', workspaceId)
      .eq('status', 'resolved')
      .not('resolved_fact_id', 'is', null)
      .limit(200),
  ])

  if (factsErr) return NextResponse.json({ error: factsErr.message }, { status: 500 })
  if (rulesErr) return NextResponse.json({ error: rulesErr.message }, { status: 500 })
  if (pendingErr) return NextResponse.json({ error: pendingErr.message }, { status: 500 })
  if (resolvedErr) return NextResponse.json({ error: resolvedErr.message }, { status: 500 })

  const occurrenceByFactId = new Map<string, number>(
    (resolvedCandidates ?? []).map((c) => [c.resolved_fact_id as string, c.occurrence_count as number])
  )
  const factsWithProvenance = (facts ?? []).map((f) => ({
    ...f,
    learned_occurrence_count: occurrenceByFactId.get(f.id) ?? null,
  }))

  return NextResponse.json({
    facts: factsWithProvenance,
    rules: rules ?? [],
    candidates: pendingCandidates ?? [],
  })
}
