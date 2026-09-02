import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { getWorkspaceFeed } from '@/lib/caye-agent/workspace-feed'
import { createBedrockAdapter } from '@/lib/domain-adapters/bedrock/runtime'
import { BEDROCK_SOURCE_SYSTEM } from '@/lib/domain-adapters/bedrock/types'
import {
  buildOperationalBrief,
  type CayeOperationalState,
  type CayeOperationalStateReader,
  type OperationalBrief,
} from './brief'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export class SupabaseCayeOperationalStateReader implements CayeOperationalStateReader {
  async read(workspaceId: string): Promise<CayeOperationalState> {
    const supabase = createServiceClient()

    const [connectionResult, mappingResult, syncResult, feed] = await Promise.all([
      supabase
        .from('domain_source_connections')
        .select('source_system, external_tenant_id, status, updated_at')
        .eq('workspace_id', workspaceId)
        .eq('source_system', BEDROCK_SOURCE_SYSTEM)
        .maybeSingle(),
      supabase
        .from('domain_entity_observation_state')
        .select('source_system, source_company_id, source_entity_type, source_entity_id, last_observed_at')
        .eq('workspace_id', workspaceId)
        .eq('source_system', BEDROCK_SOURCE_SYSTEM)
        .is('caye_entity_id', null)
        .order('last_observed_at', { ascending: false })
        .limit(50),
      supabase
        .from('domain_sync_cursors')
        .select('source_system, source_company_id, stream, updated_at, watermark')
        .eq('workspace_id', workspaceId)
        .eq('source_system', BEDROCK_SOURCE_SYSTEM)
        .order('updated_at', { ascending: false })
        .limit(20),
      getWorkspaceFeed(workspaceId, { hours: 24, limit: 30 }),
    ])

    for (const result of [connectionResult, mappingResult, syncResult]) {
      if (result.error) throw new Error(`Operational intelligence Caye-state read failed: ${result.error.message}`)
    }

    const connectionRow = connectionResult.data as {
      source_system: string
      external_tenant_id: string
      status: string
      updated_at: string
    } | null

    return {
      connection: connectionRow ? {
        sourceSystem: connectionRow.source_system,
        externalTenantId: connectionRow.external_tenant_id,
        status: connectionRow.status,
        updatedAt: connectionRow.updated_at,
      } : null,
      unresolvedMappings: ((mappingResult.data ?? []) as Array<{
        source_system: string
        source_company_id: string
        source_entity_type: string
        source_entity_id: string
        last_observed_at: string
      }>).map(row => ({
        sourceSystem: row.source_system,
        sourceCompanyId: row.source_company_id,
        sourceEntityType: row.source_entity_type,
        sourceEntityId: row.source_entity_id,
        lastObservedAt: row.last_observed_at,
      })),
      syncStates: ((syncResult.data ?? []) as Array<{
        source_system: string
        source_company_id: string
        stream: string
        updated_at: string
        watermark: string | null
      }>).map(row => ({
        sourceSystem: row.source_system,
        sourceCompanyId: row.source_company_id,
        stream: row.stream,
        updatedAt: row.updated_at,
        watermark: row.watermark,
      })),
      attentionEvents: feed.events
        .filter(event => event.type.startsWith('domain.') || event.isFailure)
        .map(event => {
          const payload = object(event.detail)
          const source = object(payload.source)
          const entity = object(payload.entity)
          const observedAt = text(payload.observed_at) ?? event.at
          const sourceSystem = text(source.system)
          const sourceEntityType = text(source.entity_type)
          const sourceEntityId = text(source.entity_id)
          const detail = text(payload.summary) ?? text(payload.description) ?? text(payload.change)
          const summary = event.isFailure
            ? `Caye recorded a failed workspace event: ${event.type}${detail ? ` — ${detail}` : ''}.`
            : `Caye observed ${event.type}${sourceEntityType && sourceEntityId ? ` for ${sourceEntityType} ${sourceEntityId}` : ''}${detail ? ` — ${detail}` : ''}.`
          return {
            id: event.id,
            type: event.type,
            occurredAt: event.at,
            observedAt,
            isFailure: event.isFailure,
            sourceSystem,
            sourceEntityType,
            sourceEntityId: sourceEntityId ?? text(entity.caye_entity_id),
            summary,
          }
        }),
    }
  }
}

export async function getOperationalBrief(workspaceId: string): Promise<OperationalBrief> {
  return buildOperationalBrief({
    workspaceId,
    source: createBedrockAdapter(),
    caye: new SupabaseCayeOperationalStateReader(),
  })
}
