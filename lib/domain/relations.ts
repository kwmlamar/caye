import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import { DomainIdentityError } from './authority'
import type { DomainRelation, DomainRelationAssertedBy, DomainRelationQuery } from './types'

/**
 * Durable relationships between canonical business entity identities.
 *
 * Cross-workspace safety is a database property here, not an application
 * convention: `business_entity_relations` references
 * `business_entities (workspace_id, id)`, so an edge whose subject and object
 * live in different workspaces cannot be inserted even through direct SQL.
 */

export const BUSINESS_ENTITY_RELATIONS_TABLE = 'business_entity_relations'

type BusinessEntityRelationRow = {
  id: string
  workspace_id: string
  subject_entity_id: string
  object_entity_id: string
  relation_type: string
  status: 'active' | 'archived'
  asserted_by: DomainRelationAssertedBy
  source_system: string | null
  source_artifact_id: string | null
  provenance: Record<string, unknown> | null
  confidence: number | null
  first_asserted_at: string
  last_asserted_at: string
}

export function toDomainRelation(row: BusinessEntityRelationRow): DomainRelation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    subjectEntityId: row.subject_entity_id,
    objectEntityId: row.object_entity_id,
    relationType: row.relation_type,
    status: row.status,
    assertedBy: row.asserted_by,
    sourceSystem: row.source_system,
    sourceArtifactId: row.source_artifact_id,
    provenance: row.provenance ?? {},
    confidence: row.confidence,
    firstAssertedAt: row.first_asserted_at,
    lastAssertedAt: row.last_asserted_at,
  }
}

export interface UpsertBusinessEntityRelationInput {
  workspaceId: string
  subjectEntityId: string
  objectEntityId: string
  /** Domain-neutral, free text. The kernel must not grow a per-industry enum. */
  relationType: string
  assertedBy: DomainRelationAssertedBy
  /** Required when `assertedBy` is 'domain_adapter'. */
  sourceSystem?: string | null
  /** Existing Caye evidence, when the belief came from an artifact. */
  sourceArtifactId?: string | null
  provenance?: Record<string, unknown>
  confidence?: number | null
  assertedAt?: string | null
}

/**
 * Asserts one durable active relation. Deterministic: polling the same
 * authoritative relationship twenty times yields one edge, because a partial
 * unique index over active edges arbitrates the conflict. Re-assertion
 * refreshes `last_asserted_at` and may fill in missing provenance, but never
 * rewrites the original assertion out of history.
 *
 * Provenance is optional on purpose. A relation handed over directly by an
 * authoritative domain adapter is already explained by `assertedBy` plus
 * `sourceSystem`; requiring a synthetic evidence record there would be a
 * second, parallel evidence universe.
 */
export async function upsertBusinessEntityRelation(
  input: UpsertBusinessEntityRelationInput
): Promise<DomainRelation> {
  if (!input.workspaceId?.trim()) {
    throw new DomainIdentityError('business entity relation requires a workspaceId')
  }
  if (!input.relationType?.trim()) {
    throw new DomainIdentityError('business entity relation requires a relationType')
  }
  if (input.subjectEntityId === input.objectEntityId) {
    throw new DomainIdentityError('business entity relation cannot point an entity at itself')
  }
  if (input.assertedBy === 'domain_adapter' && !input.sourceSystem?.trim()) {
    throw new DomainIdentityError('a domain_adapter relation must name its sourceSystem')
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase.rpc('upsert_business_entity_relation', {
    p_workspace_id: input.workspaceId,
    p_subject_entity_id: input.subjectEntityId,
    p_object_entity_id: input.objectEntityId,
    p_relation_type: input.relationType,
    p_asserted_by: input.assertedBy,
    p_source_system: input.sourceSystem ?? null,
    p_source_artifact_id: input.sourceArtifactId ?? null,
    p_provenance: input.provenance ?? {},
    p_confidence: input.confidence ?? null,
    p_asserted_at: input.assertedAt ?? null,
  })

  if (error) throw new Error(`upsert_business_entity_relation failed: ${error.message}`)
  if (!data) throw new Error('upsert_business_entity_relation returned no row')

  return toDomainRelation(data as BusinessEntityRelationRow)
}

/** Retires an active edge without deleting the history that it once held. */
export async function archiveBusinessEntityRelation(
  workspaceId: string,
  relationId: string
): Promise<void> {
  if (!workspaceId?.trim()) {
    throw new DomainIdentityError('archiveBusinessEntityRelation requires a workspaceId')
  }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from(BUSINESS_ENTITY_RELATIONS_TABLE)
    .update({ status: 'archived', archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('id', relationId)
    .eq('status', 'active')

  if (error) throw new Error(`business entity relation archive failed: ${error.message}`)
}

/** Reads the edges touching one entity. Workspace-scoped, never global. */
export async function findBusinessEntityRelations(
  workspaceId: string,
  entityId: string,
  query: DomainRelationQuery = {}
): Promise<DomainRelation[]> {
  if (!workspaceId?.trim()) {
    throw new DomainIdentityError('findBusinessEntityRelations requires a workspaceId')
  }

  const supabase = createServiceClient()
  const direction = query.direction ?? 'subject'

  let builder = supabase
    .from(BUSINESS_ENTITY_RELATIONS_TABLE)
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('status', query.status ?? 'active')
    .order('last_asserted_at', { ascending: false })
    .limit(Math.min(Math.max(query.limit ?? 200, 1), 1000))

  if (direction === 'subject') builder = builder.eq('subject_entity_id', entityId)
  else if (direction === 'object') builder = builder.eq('object_entity_id', entityId)
  else builder = builder.or(`subject_entity_id.eq.${entityId},object_entity_id.eq.${entityId}`)

  if (query.relationType) builder = builder.eq('relation_type', query.relationType.trim().toLowerCase())

  const { data, error } = await builder
  if (error) throw new Error(`business entity relation query failed: ${error.message}`)
  return (data ?? []).map((row) => toDomainRelation(row as BusinessEntityRelationRow))
}
