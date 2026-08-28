import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import type { RegisteredCapability } from './types'

export type EngineeringArtifactCapabilityItem = {
  id: string
  lineageId: string
  revision: number
  name: string
  dimensions: unknown
  calculationMetadata: unknown
  parentArtifactId: string | null
}

type EngineeringArtifactRow = {
  id: string
  lineage_id: string
  revision: number
  name: string
  dimensions: unknown
  calculation_metadata: unknown
  parent_artifact_id: string | null
}

export const engineeringArtifactsListCapability: RegisteredCapability<Record<string, never>, EngineeringArtifactCapabilityItem[]> = {
  manifest: {
    name: 'engineering.artifacts.list',
    version: 1,
    namespace: 'engineering',
    description: 'List trusted engineering artifact metadata for the active workspace.',
    access: 'read',
    risk: 'read_only',
    inputSchemaId: 'engineering.artifacts.list.input.v1',
    outputSchemaId: 'engineering.artifacts.list.output.v1',
  },

  async execute(_args, context) {
    const workspaceId = context.scope.workspaceId
    if (!workspaceId) {
      return {
        status: 'failed',
        data: null,
        evidence: [],
        executionRef: null,
        auditRef: null,
        failure: {
          code: 'invalid_scope',
          message: 'Engineering artifacts require an active workspace.',
          retryable: false,
        },
      }
    }

    try {
      const supabase = createServiceClient()
      const { data, error } = await supabase
        .from('engineering_artifacts')
        .select('id, lineage_id, revision, name, dimensions, calculation_metadata, parent_artifact_id')
        .eq('workspace_id', workspaceId)
        .order('revision', { ascending: false })
        .limit(50)

      if (error) return unavailable()

      const items = ((data ?? []) as EngineeringArtifactRow[]).map((row) => ({
        id: row.id,
        lineageId: row.lineage_id,
        revision: row.revision,
        name: row.name,
        dimensions: row.dimensions,
        calculationMetadata: row.calculation_metadata,
        parentArtifactId: row.parent_artifact_id,
      }))

      return {
        status: 'observed',
        data: items,
        evidence: items.map((item) => ({ kind: 'artifact' as const, id: item.id })),
        executionRef: null,
        auditRef: null,
        failure: null,
      }
    } catch {
      return unavailable()
    }
  },
}

function unavailable() {
  return {
    status: 'failed' as const,
    data: null,
    evidence: [],
    executionRef: null,
    auditRef: null,
    failure: {
      code: 'unavailable' as const,
      message: 'Engineering artifact state could not be read.',
      retryable: true,
    },
  }
}
