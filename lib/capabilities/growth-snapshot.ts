import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import type { RegisteredCapability } from './types'

type SourceState = {
  provider: string
  status: 'connected' | 'disconnected' | 'error'
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastErrorCode: string | null
}

type Observation = {
  id: string
  metricKey: string
  metricValue: number | null
  metricUnit: string
  observedAt: string
  periodStart: string | null
  periodEnd: string | null
  dimension: Record<string, unknown>
  provenance: Record<string, unknown>
}

type Diagnosis = {
  id: string
  diagnosisKey: string
  headline: string
  explanation: string
  confidence: number
  evidenceObservationIds: string[]
  missingSources: string[]
  freshness: 'fresh' | 'stale' | 'insufficient'
  generatedAt: string
}

type Recommendation = {
  id: string
  diagnosisId: string
  title: string
  rationale: string
  priority: number
  recommendedAction: Record<string, unknown>
}

export type GrowthSnapshot = {
  sources: SourceState[]
  observations: Observation[]
  diagnoses: Diagnosis[]
  recommendations: Recommendation[]
  coverage: {
    connectedSources: string[]
    unavailableSources: string[]
    latestObservationAt: string | null
  }
}

/**
 * Read-only evidence boundary for business growth intelligence.
 * This capability never fetches external providers and never causes actions.
 * It only returns normalized, already-observed state for the active workspace.
 * Provider failure is represented as unavailable source state; it is NEVER
 * converted into a zero metric.
 */
export const growthSnapshotCapability: RegisteredCapability<Record<string, never>, GrowthSnapshot> = {
  manifest: {
    name: 'growth.snapshot',
    version: 1,
    namespace: 'growth',
    description: 'Read the active workspace growth evidence, diagnoses, recommendations, source coverage, and freshness.',
    access: 'read',
    risk: 'read_only',
    inputSchemaId: 'growth.snapshot.input.v1',
    outputSchemaId: 'growth.snapshot.output.v1',
  },

  async execute(_args, context) {
    const workspaceId = context.scope.workspaceId
    if (!workspaceId) return invalidScope()

    try {
      const supabase = createServiceClient()
      const [sourcesResult, observationsResult, diagnosesResult, recommendationsResult] = await Promise.all([
        supabase
          .from('growth_sources')
          .select('provider,status,last_success_at,last_error_at,last_error_code')
          .eq('workspace_id', workspaceId)
          .order('provider'),
        supabase
          .from('growth_observations')
          .select('id,metric_key,metric_value,metric_unit,observed_at,period_start,period_end,dimension,provenance')
          .eq('workspace_id', workspaceId)
          .order('observed_at', { ascending: false })
          .limit(100),
        supabase
          .from('growth_diagnoses')
          .select('id,diagnosis_key,headline,explanation,confidence,evidence_observation_ids,missing_sources,freshness,generated_at')
          .eq('workspace_id', workspaceId)
          .is('superseded_at', null)
          .order('generated_at', { ascending: false })
          .limit(20),
        supabase
          .from('growth_recommendations')
          .select('id,diagnosis_id,title,rationale,priority,recommended_action')
          .eq('workspace_id', workspaceId)
          .eq('status', 'proposed')
          .order('priority', { ascending: false })
          .limit(20),
      ])

      if (sourcesResult.error || observationsResult.error || diagnosesResult.error || recommendationsResult.error) {
        return unavailable()
      }

      const sources: SourceState[] = (sourcesResult.data ?? []).map((row) => ({
        provider: row.provider,
        status: row.status,
        lastSuccessAt: row.last_success_at,
        lastErrorAt: row.last_error_at,
        lastErrorCode: row.last_error_code,
      }))

      const observations: Observation[] = (observationsResult.data ?? []).map((row) => ({
        id: row.id,
        metricKey: row.metric_key,
        metricValue: row.metric_value === null ? null : Number(row.metric_value),
        metricUnit: row.metric_unit,
        observedAt: row.observed_at,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        dimension: row.dimension ?? {},
        provenance: row.provenance ?? {},
      }))

      const diagnoses: Diagnosis[] = (diagnosesResult.data ?? []).map((row) => ({
        id: row.id,
        diagnosisKey: row.diagnosis_key,
        headline: row.headline,
        explanation: row.explanation,
        confidence: Number(row.confidence),
        evidenceObservationIds: row.evidence_observation_ids ?? [],
        missingSources: row.missing_sources ?? [],
        freshness: row.freshness,
        generatedAt: row.generated_at,
      }))

      const recommendations: Recommendation[] = (recommendationsResult.data ?? []).map((row) => ({
        id: row.id,
        diagnosisId: row.diagnosis_id,
        title: row.title,
        rationale: row.rationale,
        priority: row.priority,
        recommendedAction: row.recommended_action ?? {},
      }))

      const connectedSources = sources.filter((source) => source.status === 'connected').map((source) => source.provider)
      const unavailableSources = sources.filter((source) => source.status !== 'connected').map((source) => source.provider)

      return {
        status: diagnoses.length > 0 ? 'inferred' : 'observed',
        data: {
          sources,
          observations,
          diagnoses,
          recommendations,
          coverage: {
            connectedSources,
            unavailableSources,
            latestObservationAt: observations[0]?.observedAt ?? null,
          },
        },
        evidence: observations.map((observation) => ({ kind: 'record' as const, id: observation.id })),
        executionRef: null,
        auditRef: null,
        failure: null,
      }
    } catch {
      return unavailable()
    }
  },
}

function invalidScope() {
  return {
    status: 'failed' as const,
    data: null,
    evidence: [],
    executionRef: null,
    auditRef: null,
    failure: { code: 'invalid_scope' as const, message: 'Growth intelligence requires an active workspace.', retryable: false },
  }
}

function unavailable() {
  return {
    status: 'failed' as const,
    data: null,
    evidence: [],
    executionRef: null,
    auditRef: null,
    failure: { code: 'unavailable' as const, message: 'Growth intelligence could not be read. Source data is unknown, not zero.', retryable: true },
  }
}
