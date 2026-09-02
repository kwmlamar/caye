import 'server-only'

import { createServiceClient } from '@/lib/supabase-server'
import {
  DomainIdentityError,
  normalizeDomainEntityRef,
  type DomainAuthority,
  type DomainEntityRef,
  type DomainSourceIdentity,
} from './authority'
import type { DomainEntity, DomainEntityQuery } from './types'

/**
 * Canonical business entity identity.
 *
 * Every entry point routes through `public.resolve_business_entity`, which uses
 * the unique indexes as the concurrency arbiter. There is deliberately no
 * select-then-insert path here: two workers resolving the same external record
 * at the same instant must get the same uuid, and hoping concurrent workers
 * behave politely is not a design.
 */

export const BUSINESS_ENTITIES_TABLE = 'business_entities'

type BusinessEntityRow = {
  id: string
  workspace_id: string
  domain: string
  entity_type: string
  display_name: string | null
  authority: DomainAuthority
  source_system: string | null
  source_entity_type: string | null
  source_entity_id: string | null
  native_key: string | null
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
}

export function toDomainEntity(row: BusinessEntityRow): DomainEntity {
  const source: DomainSourceIdentity | null =
    row.source_system && row.source_entity_type && row.source_entity_id
      ? {
          sourceSystem: row.source_system,
          sourceEntityType: row.source_entity_type,
          sourceEntityId: row.source_entity_id,
        }
      : null

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    domain: row.domain,
    entityType: row.entity_type,
    displayName: row.display_name,
    authority: row.authority,
    source,
    nativeKey: row.native_key,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export type ResolveDomainEntityInput = DomainEntityRef & {
  /** Presentation only. Omitting it never blanks a name already on record. */
  displayName?: string | null
}

/**
 * Resolves an entity reference to its canonical Caye identity, registering it
 * on first sight. Idempotent: repeated resolution of the same external
 * identity returns the same uuid under retries and under concurrency.
 *
 * A reference with neither an external source identity nor a `nativeKey` has
 * no deterministic key, so it is a request for a NEW identity rather than a
 * resolution. That is legal for `caye_authoritative` and for
 * `evidence_only`/`derived_read_model`, and callers that want idempotence
 * there must supply a `nativeKey`.
 */
export async function resolveDomainEntity(input: ResolveDomainEntityInput): Promise<DomainEntity> {
  const ref = normalizeDomainEntityRef(input)
  const supabase = createServiceClient()

  const { data, error } = await supabase.rpc('resolve_business_entity', {
    p_workspace_id: ref.workspaceId,
    p_domain: ref.domain,
    p_entity_type: ref.entityType,
    p_authority: ref.authority,
    p_source_system: ref.source?.sourceSystem ?? null,
    p_source_entity_type: ref.source?.sourceEntityType ?? null,
    p_source_entity_id: ref.source?.sourceEntityId ?? null,
    p_display_name: typeof input.displayName === 'string' ? input.displayName : null,
    p_native_key: ref.nativeKey,
  })

  if (error) throw new Error(`resolve_business_entity failed: ${error.message}`)
  if (!data) throw new Error('resolve_business_entity returned no row')

  return toDomainEntity(data as BusinessEntityRow)
}

export interface RegisterCayeEntityInput {
  workspaceId: string
  domain: string
  entityType: string
  displayName?: string | null
  /**
   * Optional deterministic key for idempotent registration of something Caye
   * itself owns. Never invent a `sourceSystem` to get this behaviour.
   */
  nativeKey?: string
}

/**
 * Registers an entity whose authority lives inside Caye. Carrying an external
 * source identity here is rejected: a Caye-authoritative row that also claims
 * an external record is two contradictory authority claims.
 */
export async function registerCayeEntity(input: RegisterCayeEntityInput): Promise<DomainEntity> {
  return resolveDomainEntity({
    workspaceId: input.workspaceId,
    domain: input.domain,
    entityType: input.entityType,
    authority: 'caye_authoritative',
    nativeKey: input.nativeKey,
    displayName: input.displayName,
  })
}

/** Reads an entity by its canonical id, scoped to a workspace. */
export async function getBusinessEntity(
  workspaceId: string,
  entityId: string
): Promise<DomainEntity | null> {
  if (!workspaceId?.trim()) throw new DomainIdentityError('getBusinessEntity requires a workspaceId')

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from(BUSINESS_ENTITIES_TABLE)
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', entityId)
    .maybeSingle()

  if (error) throw new Error(`business entity read failed: ${error.message}`)
  return data ? toDomainEntity(data as BusinessEntityRow) : null
}

/**
 * Looks up an entity by its external identity without registering it. Returns
 * null when Caye has never seen the record, which is the honest answer.
 */
export async function findBusinessEntityBySource(
  workspaceId: string,
  source: DomainSourceIdentity
): Promise<DomainEntity | null> {
  if (!workspaceId?.trim()) throw new DomainIdentityError('findBusinessEntityBySource requires a workspaceId')

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from(BUSINESS_ENTITIES_TABLE)
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('source_system', source.sourceSystem.trim().toLowerCase())
    .eq('source_entity_type', source.sourceEntityType.trim().toLowerCase())
    .eq('source_entity_id', source.sourceEntityId.trim())
    .maybeSingle()

  if (error) throw new Error(`business entity source lookup failed: ${error.message}`)
  return data ? toDomainEntity(data as BusinessEntityRow) : null
}

/** Workspace-scoped entity listing. The workspace filter is not optional. */
export async function findBusinessEntities(query: DomainEntityQuery): Promise<DomainEntity[]> {
  if (!query.workspaceId?.trim()) throw new DomainIdentityError('findBusinessEntities requires a workspaceId')

  const supabase = createServiceClient()
  let builder = supabase
    .from(BUSINESS_ENTITIES_TABLE)
    .select('*')
    .eq('workspace_id', query.workspaceId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(query.limit ?? 100, 1), 500))

  if (query.domain) builder = builder.eq('domain', query.domain.trim().toLowerCase())
  if (query.entityType) builder = builder.eq('entity_type', query.entityType.trim().toLowerCase())
  if (query.authority) builder = builder.eq('authority', query.authority)
  if (query.sourceSystem) builder = builder.eq('source_system', query.sourceSystem.trim().toLowerCase())
  if (query.status) builder = builder.eq('status', query.status)

  const { data, error } = await builder
  if (error) throw new Error(`business entity query failed: ${error.message}`)
  return (data ?? []).map((row) => toDomainEntity(row as BusinessEntityRow))
}
