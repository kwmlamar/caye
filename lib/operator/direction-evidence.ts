import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ObjectiveRunResult } from './objective-run'

// This workflow executes and verifies a predeclared bounded plan. That is real
// evidence for execution/control, but it does not demonstrate that Caye can
// generate or anticipate a plan. Planning & Anticipation stays unverified until
// a runtime actually performs and verifies that behavior.
const CAPABILITY_KEYS = ['execution_autonomy', 'monitoring_control'] as const

/**
 * Feed only verified runtime execution into the canonical Operating Intelligence
 * capability substrate. This records demonstrated behavior, not an invented
 * maturity score or progress percentage.
 *
 * A completed objective is the only result promoted as positive runtime evidence.
 * Failed/blocked/budget-exhausted runs remain available in the objective audit
 * tables but never become positive capability evidence.
 */
export async function recordObjectiveDirectionEvidence(
  supabase: SupabaseClient,
  input: {
    runId: string
    objectiveKey: string
    result: ObjectiveRunResult
    summary: string
  }
): Promise<{ recorded: number; unavailable?: boolean }> {
  if (input.result.status !== 'completed') return { recorded: 0 }

  const { data: capabilities, error: capabilityError } = await supabase
    .from('caye_operating_intelligence_capabilities')
    .select('id,capability_key')
    .in('capability_key', [...CAPABILITY_KEYS])

  if (capabilityError) {
    if (capabilityError.code === '42P01') return { recorded: 0, unavailable: true }
    throw new Error(`Direction capability lookup failed: ${capabilityError.message}`)
  }

  const found = new Set((capabilities ?? []).map((capability) => capability.capability_key as string))
  if (CAPABILITY_KEYS.some((key) => !found.has(key))) {
    return { recorded: 0, unavailable: true }
  }

  const observedAt = new Date().toISOString()
  const rows = (capabilities ?? []).map((capability) => ({
    capability_id: capability.id,
    evidence_kind: 'runtime',
    source_ref: `operator_objective_run:${input.runId}`,
    summary: input.summary,
    verifies_capability: true,
    confidence: 1,
    observed_at: observedAt,
    verified_at: observedAt,
  }))

  const { error: evidenceError } = await supabase
    .from('caye_operating_intelligence_capability_evidence')
    .upsert(rows, { onConflict: 'capability_id,evidence_kind,source_ref', ignoreDuplicates: true })

  if (evidenceError) {
    if (evidenceError.code === '42P01') return { recorded: 0, unavailable: true }
    throw new Error(`Direction evidence write failed: ${evidenceError.message}`)
  }

  return { recorded: rows.length }
}
