import { describe, expect, it } from 'vitest'
import {
  DomainIdentityError,
  domainSourceIdentityKey,
  isDomainAuthority,
  normalizeDomainEntityRef,
  readDomainSourceIdentity,
  type DomainEntityRef,
} from './authority'

/**
 * The TypeScript union and `public.resolve_business_entity` must agree. These
 * cover the runtime half; the compile-time half is covered by the
 * `@ts-expect-error` cases below, which fail the typecheck if the union ever
 * loosens into three casually optional strings.
 */
describe('domain entity identity contracts', () => {
  const workspaceId = '11111111-1111-1111-1111-111111111111'

  it('accepts a complete external identity and normalizes it like the database does', () => {
    const ref = normalizeDomainEntityRef({
      workspaceId,
      domain: 'Construction',
      entityType: 'Project',
      authority: 'external_authoritative',
      sourceSystem: 'Bedrock',
      sourceEntityType: 'Project',
      sourceEntityId: '  abc-123  ',
    })

    expect(ref.domain).toBe('construction')
    expect(ref.entityType).toBe('project')
    expect(ref.source).toEqual({
      sourceSystem: 'bedrock',
      sourceEntityType: 'project',
      sourceEntityId: 'abc-123',
    })
  })

  it('rejects a partial source identity', () => {
    expect(() =>
      readDomainSourceIdentity({ sourceSystem: 'bedrock', sourceEntityId: 'abc' })
    ).toThrow(DomainIdentityError)
    expect(() =>
      readDomainSourceIdentity({ sourceSystem: 'bedrock', sourceEntityType: 'project', sourceEntityId: '  ' })
    ).toThrow(/all present or all absent/i)
  })

  it('treats an absent source identity as absent rather than partial', () => {
    expect(readDomainSourceIdentity({})).toBeNull()
  })

  it('requires a source identity for external_authoritative', () => {
    expect(() =>
      normalizeDomainEntityRef({
        workspaceId,
        domain: 'construction',
        entityType: 'project',
        authority: 'external_authoritative',
      } as unknown as DomainEntityRef)
    ).toThrow(/requires a complete external source identity/i)
  })

  it('forbids a source identity on caye_authoritative', () => {
    expect(() =>
      normalizeDomainEntityRef({
        workspaceId,
        domain: 'operations',
        entityType: 'commitment',
        authority: 'caye_authoritative',
        sourceSystem: 'bedrock',
        sourceEntityType: 'project',
        sourceEntityId: 'abc',
      } as unknown as DomainEntityRef)
    ).toThrow(/must not carry external source identity/i)
  })

  it('allows evidence_only and derived_read_model either way', () => {
    expect(
      normalizeDomainEntityRef({
        workspaceId,
        domain: 'comms',
        entityType: 'email_thread',
        authority: 'evidence_only',
        sourceSystem: 'gmail',
        sourceEntityType: 'thread',
        sourceEntityId: 'thread-1',
      }).source
    ).not.toBeNull()

    expect(
      normalizeDomainEntityRef({
        workspaceId,
        domain: 'comms',
        entityType: 'email_thread',
        authority: 'derived_read_model',
      }).source
    ).toBeNull()
  })

  it('restricts nativeKey to Caye-authoritative entities', () => {
    expect(
      normalizeDomainEntityRef({
        workspaceId,
        domain: 'operations',
        entityType: 'commitment',
        authority: 'caye_authoritative',
        nativeKey: 'procurement-followthrough',
      }).nativeKey
    ).toBe('procurement-followthrough')

    expect(() =>
      normalizeDomainEntityRef({
        workspaceId,
        domain: 'comms',
        entityType: 'email_thread',
        authority: 'derived_read_model',
        nativeKey: 'nope',
      } as unknown as DomainEntityRef)
    ).toThrow(/nativeKey is only valid/i)
  })

  it('rejects references missing workspace, domain, entity type or a known authority', () => {
    const base = { workspaceId, domain: 'construction', entityType: 'project', authority: 'caye_authoritative' }
    expect(() => normalizeDomainEntityRef({ ...base, workspaceId: '  ' } as DomainEntityRef)).toThrow(/workspaceId/)
    expect(() => normalizeDomainEntityRef({ ...base, domain: '' } as DomainEntityRef)).toThrow(/domain/)
    expect(() => normalizeDomainEntityRef({ ...base, entityType: '' } as DomainEntityRef)).toThrow(/entityType/)
    expect(() =>
      normalizeDomainEntityRef({ ...base, authority: 'source_of_truth' } as unknown as DomainEntityRef)
    ).toThrow(/unsupported domain authority/i)
  })

  it('recognises exactly the four authority classes', () => {
    expect(isDomainAuthority('caye_authoritative')).toBe(true)
    expect(isDomainAuthority('external_authoritative')).toBe(true)
    expect(isDomainAuthority('evidence_only')).toBe(true)
    expect(isDomainAuthority('derived_read_model')).toBe(true)
    expect(isDomainAuthority('source_of_truth')).toBe(false)
    expect(isDomainAuthority(undefined)).toBe(false)
  })

  it('makes invalid authority/source combinations unrepresentable at compile time', () => {
    // @ts-expect-error caye_authoritative must not carry a source identity
    const invalidNative: DomainEntityRef = {
      workspaceId,
      domain: 'operations',
      entityType: 'commitment',
      authority: 'caye_authoritative',
      sourceSystem: 'bedrock',
      sourceEntityType: 'project',
      sourceEntityId: 'abc',
    }

    // @ts-expect-error external_authoritative requires the complete triplet
    const invalidExternal: DomainEntityRef = {
      workspaceId,
      domain: 'construction',
      entityType: 'project',
      authority: 'external_authoritative',
      sourceSystem: 'bedrock',
    }

    expect(invalidNative.authority).toBe('caye_authoritative')
    expect(invalidExternal.authority).toBe('external_authoritative')
  })

  it('produces a stable cache key that is never used as an identity of record', () => {
    const key = domainSourceIdentityKey(workspaceId, {
      sourceSystem: 'bedrock',
      sourceEntityType: 'project',
      sourceEntityId: 'abc',
    })
    expect(key).toBe(JSON.stringify([workspaceId, 'bedrock', 'project', 'abc']))
  })
})
