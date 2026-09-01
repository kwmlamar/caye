import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import type { DurableOutcomeEvidence } from './outcomes'
import { recordRecommendationObservation } from './observations'

type ClaimedObservation = {
  id: string
  recommendation_id: string
  decision_id: string
  recommendation_fingerprint: string
  scope: 'operator' | 'workspace'
  workspace_id: string | null
  observer_key: string
  expected_effect: Record<string, unknown>
  state: 'pending'
  registered_at: string
  next_observation_at: string | null
  expires_at: string
  cadence_seconds: number
  max_observations: number
  observation_count: number
  claim_token: string
}

type MeasurementDraft = {
  metricKey: string
  baselineValue: number
  observedValue: number
  unit: string
  direction: 'positive' | 'negative' | 'neutral' | 'unknown'
  measurable: boolean
  provenance: Record<string, unknown>
}

type CadenceExpectation = {
  deskId: string
  baselineStart: string
  baselineEnd: string
  minimumCycleRateReductionFraction: number
  maxMaterialDiscoveryRateDropFraction: number
}

const TERMINAL_CYCLE_STATUSES = ['completed', 'partial', 'budget_exhausted', 'unchanged']
const MAX_CYCLES_PER_WINDOW = 500

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parseCadenceExpectation(value: Record<string, unknown>): CadenceExpectation {
  const deskId = typeof value.deskId === 'string' ? value.deskId.trim() : ''
  const baselineStart = typeof value.baselineStart === 'string' ? value.baselineStart : ''
  const baselineEnd = typeof value.baselineEnd === 'string' ? value.baselineEnd : ''
  const baselineStartMs = Date.parse(baselineStart)
  const baselineEndMs = Date.parse(baselineEnd)
  if (!deskId || !Number.isFinite(baselineStartMs) || !Number.isFinite(baselineEndMs) || baselineEndMs <= baselineStartMs) {
    throw new Error('research cadence observer requires deskId and a valid baselineStart/baselineEnd window')
  }

  const minimumCycleRateReductionFraction = Math.min(0.95, Math.max(0, finiteNumber(value.minimumCycleRateReductionFraction, 0.1)))
  const maxMaterialDiscoveryRateDropFraction = Math.min(1, Math.max(0, finiteNumber(value.maxMaterialDiscoveryRateDropFraction, 0.1)))
  return { deskId, baselineStart, baselineEnd, minimumCycleRateReductionFraction, maxMaterialDiscoveryRateDropFraction }
}

function daysBetween(start: string, end: string): number {
  return Math.max((Date.parse(end) - Date.parse(start)) / 86_400_000, 1 / 24)
}

function compareLowerIsBetter(baseline: number, observed: number, requiredReduction: number): MeasurementDraft['direction'] {
  if (baseline === 0) return observed === 0 ? 'neutral' : 'negative'
  const target = baseline * (1 - requiredReduction)
  if (observed <= target) return 'positive'
  if (observed > baseline * 1.05) return 'negative'
  return 'neutral'
}

function compareHigherIsBetter(baseline: number, observed: number, allowedDrop: number): MeasurementDraft['direction'] {
  if (baseline === 0) return observed > 0 ? 'positive' : 'neutral'
  if (observed < baseline * (1 - allowedDrop)) return 'negative'
  if (observed > baseline * 1.05) return 'positive'
  return 'neutral'
}

async function readResearchDeskWindow(input: {
  deskId: string
  start: string
  end: string
}): Promise<{ cycleCount: number; materialCount: number; truncated: boolean }> {
  const db = createServiceClient()
  const result = await db
    .from('research_desk_cycles')
    .select('id,material_change,status,completed_at')
    .eq('desk_id', input.deskId)
    .in('status', TERMINAL_CYCLE_STATUSES)
    .gte('completed_at', input.start)
    .lt('completed_at', input.end)
    .order('completed_at', { ascending: true })
    .limit(MAX_CYCLES_PER_WINDOW + 1)
  if (result.error) throw result.error
  const rows = result.data ?? []
  const truncated = rows.length > MAX_CYCLES_PER_WINDOW
  const bounded = rows.slice(0, MAX_CYCLES_PER_WINDOW)
  return {
    cycleCount: bounded.length,
    materialCount: bounded.filter((row) => row.material_change === true).length,
    truncated,
  }
}

async function observeResearchCadence(
  observation: ClaimedObservation,
  observedAt: string,
): Promise<MeasurementDraft[]> {
  const expected = parseCadenceExpectation(observation.expected_effect)
  const db = createServiceClient()
  const deskResult = await db.from('research_desks').select('id,workspace_id').eq('id', expected.deskId).maybeSingle()
  if (deskResult.error) throw deskResult.error
  if (!deskResult.data) throw new Error('research cadence observer desk not found')
  if ((deskResult.data.workspace_id ?? null) !== observation.workspace_id) {
    throw new Error('research cadence observer workspace mismatch')
  }

  const postStart = observation.registered_at
  if (Date.parse(observedAt) <= Date.parse(postStart)) return []

  const [baseline, observed] = await Promise.all([
    readResearchDeskWindow({ deskId: expected.deskId, start: expected.baselineStart, end: expected.baselineEnd }),
    readResearchDeskWindow({ deskId: expected.deskId, start: postStart, end: observedAt }),
  ])
  if (baseline.truncated || observed.truncated || baseline.cycleCount === 0) return []

  const baselineDays = daysBetween(expected.baselineStart, expected.baselineEnd)
  const observedDays = daysBetween(postStart, observedAt)
  const baselineCycleRate = baseline.cycleCount / baselineDays
  const observedCycleRate = observed.cycleCount / observedDays
  const baselineMaterialRate = baseline.materialCount / baselineDays
  const observedMaterialRate = observed.materialCount / observedDays

  return [
    {
      metricKey: 'research_cycle_rate_per_day',
      baselineValue: baselineCycleRate,
      observedValue: observedCycleRate,
      unit: 'cycles/day',
      direction: compareLowerIsBetter(baselineCycleRate, observedCycleRate, expected.minimumCycleRateReductionFraction),
      measurable: true,
      provenance: {
        kind: 'system_metric',
        observer: 'research.cadence-effect.v1',
        sourceTable: 'research_desk_cycles',
        deskId: expected.deskId,
        baselineWindow: [expected.baselineStart, expected.baselineEnd],
        observedWindow: [postStart, observedAt],
        baselineCycleCount: baseline.cycleCount,
        observedCycleCount: observed.cycleCount,
      },
    },
    {
      metricKey: 'research_material_discovery_rate_per_day',
      baselineValue: baselineMaterialRate,
      observedValue: observedMaterialRate,
      unit: 'material_changes/day',
      direction: compareHigherIsBetter(baselineMaterialRate, observedMaterialRate, expected.maxMaterialDiscoveryRateDropFraction),
      measurable: true,
      provenance: {
        kind: 'system_metric',
        observer: 'research.cadence-effect.v1',
        sourceTable: 'research_desk_cycles',
        deskId: expected.deskId,
        baselineWindow: [expected.baselineStart, expected.baselineEnd],
        observedWindow: [postStart, observedAt],
        baselineMaterialCount: baseline.materialCount,
        observedMaterialCount: observed.materialCount,
      },
    },
  ]
}

async function persistMeasurements(input: {
  observation: ClaimedObservation
  drafts: MeasurementDraft[]
  observedAt: string
}): Promise<DurableOutcomeEvidence[]> {
  const db = createServiceClient()
  const evidence: DurableOutcomeEvidence[] = []
  for (const draft of input.drafts) {
    const measuredDelta = draft.observedValue - draft.baselineValue
    const result = await db.rpc('record_caye_recommendation_outcome_observation_measurement', {
      p_observation_id: input.observation.id,
      p_claim_token: input.observation.claim_token,
      p_metric_key: draft.metricKey,
      p_baseline_value: draft.baselineValue,
      p_observed_value: draft.observedValue,
      p_measured_delta: measuredDelta,
      p_unit: draft.unit,
      p_direction: draft.direction,
      p_measurable: draft.measurable,
      p_observed_at: input.observedAt,
      p_provenance: draft.provenance,
    })
    if (result.error) throw result.error
    const row = result.data as { id?: string } | null
    if (!row?.id) throw new Error('recommendation observation measurement was not persisted')
    evidence.push({
      evidenceKind: 'system_metric',
      sourceTable: 'caye_recommendation_outcome_observation_measurements',
      sourceId: row.id,
      observedAt: input.observedAt,
      direction: draft.direction,
      measurable: draft.measurable,
      measuredDelta,
      unit: draft.unit,
      provenance: draft.provenance,
    })
  }
  return evidence
}

async function advanceWithoutEvidence(observation: ClaimedObservation, observedAt: string) {
  return recordRecommendationObservation({
    observation: {
      id: observation.id,
      recommendationId: observation.recommendation_id,
      decisionId: observation.decision_id,
      workspaceId: observation.workspace_id,
      state: observation.state,
      nextObservationAt: observation.next_observation_at,
      expiresAt: observation.expires_at,
      observationCount: observation.observation_count,
      maxObservations: observation.max_observations,
      cadenceSeconds: observation.cadence_seconds,
      claimToken: observation.claim_token,
    },
    evidence: [],
    observedAt,
  })
}

/** Process at most one claimed observation per existing research-worker invocation. */
export async function runNextRecommendationOutcomeObservation(workerId: string) {
  const db = createServiceClient()
  const now = new Date().toISOString()
  const claimedResult = await db.rpc('claim_due_caye_recommendation_outcome_observation', {
    p_worker: workerId,
    p_now: now,
  })
  if (claimedResult.error) throw claimedResult.error
  const observation = claimedResult.data as ClaimedObservation | null
  if (!observation?.id) return { status: 'idle' as const }

  if (Date.parse(now) >= Date.parse(observation.expires_at)) {
    const advanced = await advanceWithoutEvidence(observation, now)
    return { status: 'expired' as const, observationId: observation.id, outcome: advanced.outcome }
  }

  try {
    let drafts: MeasurementDraft[]
    switch (observation.observer_key) {
      case 'research.cadence-effect.v1':
        drafts = await observeResearchCadence(observation, now)
        break
      default:
        drafts = []
    }

    const evidence = await persistMeasurements({ observation, drafts, observedAt: now })
    const result = await recordRecommendationObservation({
      observation: {
        id: observation.id,
        recommendationId: observation.recommendation_id,
        decisionId: observation.decision_id,
        workspaceId: observation.workspace_id,
        state: observation.state,
        nextObservationAt: observation.next_observation_at,
        expiresAt: observation.expires_at,
        observationCount: observation.observation_count,
        maxObservations: observation.max_observations,
        cadenceSeconds: observation.cadence_seconds,
        claimToken: observation.claim_token,
      },
      evidence,
      observedAt: now,
    })
    return {
      status: evidence.length ? 'observed' as const : 'unknown' as const,
      observationId: observation.id,
      evidenceCount: evidence.length,
      evidenceSufficient: result.evidenceSufficient,
      observationState: (result.observation as { state?: string } | null)?.state ?? null,
      outcome: result.outcome,
    }
  } catch (error) {
    // A broken sensor must not create an infinite retry loop. Consume one bounded
    // observation attempt with no objective evidence and let the finite cadence retry.
    const advanced = await advanceWithoutEvidence(observation, now)
    return {
      status: 'failed' as const,
      observationId: observation.id,
      error: error instanceof Error ? error.message : String(error),
      observationState: (advanced.observation as { state?: string } | null)?.state ?? null,
    }
  }
}
