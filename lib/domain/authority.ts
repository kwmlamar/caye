/**
 * Domain authority and entity identity contracts.
 *
 * Deliberately free of `server-only` and of any Supabase import: adapters,
 * bridges and pure tests all need these shapes, and none of them should have
 * to drag a database client along to describe an entity.
 *
 * The one invariant this file exists to protect: an entity reference either
 * carries a complete external source identity or none at all, and which of
 * those is legal is decided by the authority class. Three casually optional
 * strings would let a half-specified identity compile, and a half-specified
 * identity is what produces duplicate canonical ids under retry.
 */

export type DomainAuthority =
  | 'caye_authoritative'
  | 'external_authoritative'
  | 'evidence_only'
  | 'derived_read_model'

export const DOMAIN_AUTHORITIES: readonly DomainAuthority[] = [
  'caye_authoritative',
  'external_authoritative',
  'evidence_only',
  'derived_read_model',
]

/** The external identity triplet. All three, or none of the three. */
export interface DomainSourceIdentity {
  sourceSystem: string
  sourceEntityType: string
  sourceEntityId: string
}

/** Negative form, so "no source identity" is expressible in the union below. */
export interface NoDomainSourceIdentity {
  sourceSystem?: never
  sourceEntityType?: never
  sourceEntityId?: never
}

export interface DomainEntityRefBase {
  workspaceId: string
  domain: string
  entityType: string
}

/**
 * `caye_authoritative` forbids external source identity.
 * `external_authoritative` requires it.
 * `evidence_only` and `derived_read_model` allow either, because a derived
 * read model may be built from Caye's own state or from a source system.
 */
export type DomainEntityRef =
  | (DomainEntityRefBase & {
      authority: 'caye_authoritative'
      /** Explicit deterministic key for Caye-owned identities. Never a source id. */
      nativeKey?: string
    } & NoDomainSourceIdentity)
  | (DomainEntityRefBase & { authority: 'external_authoritative' } & DomainSourceIdentity)
  | (DomainEntityRefBase & { authority: 'evidence_only' | 'derived_read_model' } & (
      | DomainSourceIdentity
      | NoDomainSourceIdentity
    ))

export type ExternalDomainEntityRef = Extract<DomainEntityRef, { authority: 'external_authoritative' }>
export type CayeDomainEntityRef = Extract<DomainEntityRef, { authority: 'caye_authoritative' }>

export class DomainIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainIdentityError'
  }
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Reads the source identity off a candidate reference, rejecting the partial
 * case. Returns null when the reference legitimately carries none.
 *
 * Normalisation matches `public.resolve_business_entity`: system and type
 * names fold to lower case, the external id is trimmed but otherwise
 * preserved, because external ids are frequently case-sensitive and folding
 * them would silently merge two distinct external records.
 */
export function readDomainSourceIdentity(
  ref: Partial<DomainSourceIdentity> & Record<string, unknown>
): DomainSourceIdentity | null {
  const sourceSystem = trimmed(ref.sourceSystem)
  const sourceEntityType = trimmed(ref.sourceEntityType)
  const sourceEntityId = trimmed(ref.sourceEntityId)

  const present = [sourceSystem, sourceEntityType, sourceEntityId].filter((value) => value !== null).length
  if (present === 0) return null
  if (present !== 3) {
    throw new DomainIdentityError(
      'partial external source identity: sourceSystem/sourceEntityType/sourceEntityId must be all present or all absent'
    )
  }

  return {
    sourceSystem: sourceSystem!.toLowerCase(),
    sourceEntityType: sourceEntityType!.toLowerCase(),
    sourceEntityId: sourceEntityId!,
  }
}

export function isDomainAuthority(value: unknown): value is DomainAuthority {
  return typeof value === 'string' && (DOMAIN_AUTHORITIES as readonly string[]).includes(value)
}

export interface NormalizedDomainEntityRef {
  workspaceId: string
  domain: string
  entityType: string
  authority: DomainAuthority
  source: DomainSourceIdentity | null
  nativeKey: string | null
}

/**
 * The single validation gate every caller shares, so the TypeScript union and
 * the database constraints cannot drift. Anything this accepts the migration
 * accepts; anything the migration rejects this rejects first, with a message
 * that names the offending field.
 */
export function normalizeDomainEntityRef(ref: DomainEntityRef): NormalizedDomainEntityRef {
  const candidate = ref as unknown as Record<string, unknown>
  const workspaceId = trimmed(candidate.workspaceId)
  const domain = trimmed(candidate.domain)
  const entityType = trimmed(candidate.entityType)
  const authority = candidate.authority

  if (!workspaceId) throw new DomainIdentityError('domain entity reference requires a workspaceId')
  if (!domain) throw new DomainIdentityError('domain entity reference requires a domain')
  if (!entityType) throw new DomainIdentityError('domain entity reference requires an entityType')
  if (!isDomainAuthority(authority)) {
    throw new DomainIdentityError(`unsupported domain authority: ${String(authority ?? '(missing)')}`)
  }

  const source = readDomainSourceIdentity(candidate as Partial<DomainSourceIdentity> & Record<string, unknown>)
  const nativeKey = trimmed(candidate.nativeKey)

  if (authority === 'external_authoritative' && !source) {
    throw new DomainIdentityError('external_authoritative requires a complete external source identity')
  }
  if (authority === 'caye_authoritative' && source) {
    throw new DomainIdentityError('caye_authoritative must not carry external source identity')
  }
  if (nativeKey && authority !== 'caye_authoritative') {
    throw new DomainIdentityError('nativeKey is only valid for caye_authoritative entities')
  }

  return {
    workspaceId,
    domain: domain.toLowerCase(),
    entityType: entityType.toLowerCase(),
    authority,
    source,
    nativeKey,
  }
}

/**
 * Stable string form of an external identity, for logs and in-process cache
 * keys. Never an identity of record: the canonical id is the uuid the database
 * hands back.
 */
export function domainSourceIdentityKey(workspaceId: string, source: DomainSourceIdentity): string {
  // JSON rather than a delimiter join: external ids are opaque and may contain
  // whatever separator seemed safe at the time.
  return JSON.stringify([
    workspaceId,
    source.sourceSystem,
    source.sourceEntityType,
    source.sourceEntityId,
  ])
}
