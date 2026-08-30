import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import type { RegisteredCapability } from './types'

type PerceptionSource = {
  sourceKind: string
  sourceIdentity: string
  status: string
  lastObservedAt: string | null
  freshUntil: string | null
  confidence: number
  consecutiveFailures: number
  lastFailureCode: string | null
}

type CapabilityEvidence = {
  capabilityKey: string
  sourceKind: string
  sourceIdentity: string
  status: 'foundation' | 'active' | 'limited' | 'future' | 'error'
  autonomousNow: boolean
  evidenceEventId: number | null
  lastObservedAt: string | null
  freshUntil: string | null
  confidence: number
  notes: string | null
  metadata: Record<string, unknown>
}

export type PerceptionStatus = {
  sources: PerceptionSource[]
  capabilities: CapabilityEvidence[]
  summary: {
    activeSources: number
    autonomousSources: number
    staleSources: number
    latestObservationAt: string | null
  }
}

/**
 * Workspace-scoped, read-only evidence for Direction/founder reasoning.
 * This reports what has actually produced evidence. It does not infer future
 * support merely because a connector or table exists.
 */
export const perceptionStatusCapability: RegisteredCapability<Record<string, never>, PerceptionStatus> = {
  manifest: {
    name: 'perception.status',
    version: 1,
    namespace: 'perception',
    description: 'Read workspace-scoped perception sources, freshness, failures, and evidence of what monitoring is genuinely autonomous now.',
    access: 'read',
    risk: 'read_only',
    inputSchemaId: 'perception.status.input.v1',
    outputSchemaId: 'perception.status.output.v1',
  },

  async execute(_args, context) {
    const workspaceId = context.scope.workspaceId
    if (!workspaceId) return invalidScope()

    try {
      const supabase = createServiceClient()
      const [sourceResult, capabilityResult] = await Promise.all([
        supabase
          .from('perception_source_state')
          .select('source_kind,source_identity,status,last_observed_at,fresh_until,confidence,consecutive_failures,last_failure_code')
          .eq('workspace_id', workspaceId)
          .order('source_kind'),
        supabase
          .from('perception_capability_evidence')
          .select('capability_key,source_kind,source_identity,status,autonomous_now,evidence_event_id,last_observed_at,fresh_until,confidence,notes,metadata')
          .eq('workspace_id', workspaceId)
          .order('capability_key'),
      ])

      if (sourceResult.error || capabilityResult.error) return unavailable()

      const sources: PerceptionSource[] = (sourceResult.data ?? []).map((row) => ({
        sourceKind: row.source_kind,
        sourceIdentity: row.source_identity,
        status: row.status,
        lastObservedAt: row.last_observed_at,
        freshUntil: row.fresh_until,
        confidence: Number(row.confidence),
        consecutiveFailures: row.consecutive_failures,
        lastFailureCode: row.last_failure_code,
      }))
      const capabilities: CapabilityEvidence[] = (capabilityResult.data ?? []).map((row) => ({
        capabilityKey: row.capability_key,
        sourceKind: row.source_kind,
        sourceIdentity: row.source_identity,
        status: row.status,
        autonomousNow: row.autonomous_now,
        evidenceEventId: row.evidence_event_id === null ? null : Number(row.evidence_event_id),
        lastObservedAt: row.last_observed_at,
        freshUntil: row.fresh_until,
        confidence: Number(row.confidence),
        notes: row.notes,
        metadata: row.metadata ?? {},
      }))

      const now = Date.now()
      const latestObservationAt = sources
        .map((source) => source.lastObservedAt)
        .filter((value): value is string => !!value)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null

      return {
        status: sources.length > 0 ? 'observed' : 'empty',
        data: {
          sources,
          capabilities,
          summary: {
            activeSources: sources.filter((source) => source.status === 'active').length,
            autonomousSources: capabilities.filter((capability) => capability.autonomousNow && capability.status === 'active').length,
            staleSources: sources.filter((source) => source.freshUntil !== null && Date.parse(source.freshUntil) < now).length,
            latestObservationAt,
          },
        },
        evidence: capabilities
          .filter((capability) => capability.evidenceEventId !== null)
          .map((capability) => ({ kind: 'record' as const, id: String(capability.evidenceEventId) })),
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
    failure: { code: 'invalid_scope' as const, message: 'Perception status requires an active workspace.', retryable: false },
  }
}

function unavailable() {
  return {
    status: 'failed' as const,
    data: null,
    evidence: [],
    executionRef: null,
    auditRef: null,
    failure: { code: 'unavailable' as const, message: 'Perception evidence could not be read; monitoring state is unknown.', retryable: true },
  }
}
