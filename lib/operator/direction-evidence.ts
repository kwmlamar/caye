import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ObjectiveRunResult } from './objective-run'

const CAPABILITY_KEYS = ['planning_decomposition', 'tool_action_execution', 'verification_quality'] as const

/**
 * Feed only verified runtime execution into the canonical Direction capability
 * roadmap introduced by the Operating Intelligence capability layer. This is
 * deliberately runtime evidence, not a maturity mutation: Direction's
 * assessment process decides what the evidence means.
 *
 * A completed objective is the only result that proves autonomous execution.
 * Failed/blocked/budget-exhausted runs remain available in the objective audit
 * tables but are not promoted as positive capability evidence.
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
    .from('caye_goal_capabilities')
    .select('goal_id,capability_key')
    .in('capability_key', [...CAPABILITY_KEYS])

  // PR #255 owns this schema. Keep objective execution deployable before that
  // code merges, while still making the dependency explicit and observable.
  if (capabilityError) {
    if (capabilityError.code === '42P01') return { recorded: 0, unavailable: true }
    throw new Error(`Direction capability lookup failed: ${capabilityError.message}`)
  }

  const rows = (capabilities ?? []).map((capability) => ({
    goal_id: capability.goal_id,
    evidence_type: 'runtime',
    evidence_ref: `operator_objective_run:${input.runId}`,
    summary: input.summary,
    confidence: 1,
    observed_at: new Date().toISOString(),
  }))
  if (rows.length === 0) return { recorded: 0, unavailable: true }

  const { error: evidenceError } = await supabase
    .from('caye_goal_capability_evidence')
    .upsert(rows, { onConflict: 'goal_id,evidence_type,evidence_ref', ignoreDuplicates: true })

  if (evidenceError) {
    if (evidenceError.code === '42P01') return { recorded: 0, unavailable: true }
    throw new Error(`Direction evidence write failed: ${evidenceError.message}`)
  }

  return { recorded: rows.length }
}
