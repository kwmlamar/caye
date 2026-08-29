import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPropertySnapshot: vi.fn(),
  resolveFounderPropertyWorkspaceId: vi.fn(),
  listEngineeringProjects: vi.fn(),
}))

vi.mock('@/lib/property/store', () => ({
  getPropertySnapshot: mocks.getPropertySnapshot,
  resolveFounderPropertyWorkspaceId: mocks.resolveFounderPropertyWorkspaceId,
}))
vi.mock('@/lib/engineering-projects/store', () => ({
  listEngineeringProjects: mocks.listEngineeringProjects,
}))

import { propertySnapshotCapability } from './property-snapshot'

const baseContext = {
  actor: { kind: 'founder' as const, userId: 'founder-1' },
  scope: { workspaceId: null },
  caller: 'external_reasoner' as const,
}

const rawSnapshot = {
  property: {
    id: 'property-1',
    name: 'Bimini Villa',
    property_type: 'residential',
    location_label: 'North Bimini',
    status: 'active',
    metadata: { roof: 'metal' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  },
  structures: [{ id: 'structure-1', name: 'Main House', structure_type: 'building', metadata: {} }],
  systems: [
    { id: 'system-1', structure_id: 'structure-1', name: 'Well pump', system_type: 'water', status: 'active', metadata: {} },
    { id: 'system-2', structure_id: 'structure-1', name: 'Cistern', system_type: 'water', status: 'needs_attention', metadata: {} },
  ],
  assets: [
    { id: 'asset-1', structure_id: 'structure-1', system_id: 'system-1', name: 'Pump motor', asset_type: 'pump', manufacturer: 'Grundfos', model: 'CR3', status: 'operational', specifications: {} },
    { id: 'asset-2', structure_id: 'structure-1', system_id: 'system-2', name: 'Cistern liner', asset_type: 'tank', manufacturer: null, model: null, status: 'unknown', specifications: {} },
  ],
  current_observations: [
    { id: 'obs-1', structure_id: null, system_id: 'system-1', asset_id: null, observation_key: 'flow_rate', numeric_value: 12, text_value: null, unit: 'gpm', provenance_status: 'measured', confidence: 0.9, observed_at: '2026-01-03T00:00:00Z', created_at: '2026-01-03T00:00:00Z', notes: null },
  ],
  observations: [],
}

const rawProjects = [
  { id: 'project-1', property_id: 'property-1', name: 'Cistern rehab', objective: 'Stop leak', status: 'planning', priority: 'high', updated_at: '2026-01-04T00:00:00Z' },
]

describe('property.snapshot capability', () => {
  beforeEach(() => vi.clearAllMocks())

  it('requires a non-empty propertyId and never queries storage without one', async () => {
    const missing = await propertySnapshotCapability.execute({}, baseContext)
    expect(missing).toMatchObject({ status: 'failed', failure: { code: 'invalid_args', retryable: false } })
    expect(mocks.resolveFounderPropertyWorkspaceId).not.toHaveBeenCalled()

    const blank = await propertySnapshotCapability.execute({ propertyId: '   ' }, baseContext)
    expect(blank).toMatchObject({ status: 'failed', failure: { code: 'invalid_args' } })
    expect(mocks.resolveFounderPropertyWorkspaceId).not.toHaveBeenCalled()
  })

  it('resolves scope canonically from propertyId, ignoring any caller-supplied workspace scope', async () => {
    mocks.resolveFounderPropertyWorkspaceId.mockResolvedValue('workspace-real')
    mocks.getPropertySnapshot.mockResolvedValue(rawSnapshot)
    mocks.listEngineeringProjects.mockResolvedValue(rawProjects)

    const result = await propertySnapshotCapability.execute({ propertyId: 'property-1' }, {
      ...baseContext,
      scope: { workspaceId: 'attacker-supplied-workspace' },
    })

    expect(mocks.resolveFounderPropertyWorkspaceId).toHaveBeenCalledWith('property-1')
    expect(mocks.getPropertySnapshot).toHaveBeenCalledWith('workspace-real', 'property-1')
    expect(mocks.listEngineeringProjects).toHaveBeenCalledWith('workspace-real', 'property-1')
    expect(result.status).toBe('observed')
  })

  it('an arbitrary property selector cannot cross into another property/workspace: unknown id is a clean not_found, not a partial leak', async () => {
    mocks.resolveFounderPropertyWorkspaceId.mockResolvedValue(null)

    const result = await propertySnapshotCapability.execute({ propertyId: 'attacker-guessed-uuid' }, baseContext)

    expect(result).toMatchObject({ status: 'failed', data: null, failure: { code: 'not_found', retryable: false } })
    expect(mocks.getPropertySnapshot).not.toHaveBeenCalled()
    expect(mocks.listEngineeringProjects).not.toHaveBeenCalled()
  })

  it('returns founder-safe structured state with evidence and human-readable linkage instead of nested ids', async () => {
    mocks.resolveFounderPropertyWorkspaceId.mockResolvedValue('workspace-a')
    mocks.getPropertySnapshot.mockResolvedValue(rawSnapshot)
    mocks.listEngineeringProjects.mockResolvedValue(rawProjects)

    const result = await propertySnapshotCapability.execute({ propertyId: 'property-1' }, baseContext)

    expect(result.status).toBe('observed')
    expect(result.data).toEqual({
      property: { id: 'property-1', name: 'Bimini Villa', propertyType: 'residential', locationLabel: 'North Bimini', status: 'active' },
      structures: [{ name: 'Main House', structureType: 'building' }],
      systems: [
        { name: 'Well pump', systemType: 'water', status: 'active', structureName: 'Main House' },
        { name: 'Cistern', systemType: 'water', status: 'needs_attention', structureName: 'Main House' },
      ],
      assets: [
        { name: 'Pump motor', assetType: 'pump', manufacturer: 'Grundfos', model: 'CR3', status: 'operational', structureName: 'Main House', systemName: 'Well pump' },
        { name: 'Cistern liner', assetType: 'tank', manufacturer: null, model: null, status: 'unknown', structureName: 'Main House', systemName: 'Cistern' },
      ],
      currentObservations: [
        { key: 'flow_rate', numericValue: 12, textValue: null, unit: 'gpm', provenanceStatus: 'measured', confidence: 0.9, observedAt: '2026-01-03T00:00:00Z', notes: null, subjectLabel: 'Well pump' },
      ],
      projects: [{ name: 'Cistern rehab', objective: 'Stop leak', status: 'planning', priority: 'high', updatedAt: '2026-01-04T00:00:00Z' }],
      openIssues: [
        { kind: 'system', name: 'Cistern', status: 'needs_attention' },
        { kind: 'asset', name: 'Cistern liner', status: 'unknown' },
      ],
    })
    // Internal record ids may remain in evidence, per the existing evidence contract.
    expect(result.evidence).toContainEqual({ kind: 'record', id: 'property-1' })
    expect(result.evidence).toContainEqual({ kind: 'record', id: 'structure-1' })
    expect(result.evidence).toContainEqual({ kind: 'record', id: 'project-1' })
  })

  it('does not fabricate a result when the property is unknown', async () => {
    mocks.resolveFounderPropertyWorkspaceId.mockResolvedValue(null)

    const result = await propertySnapshotCapability.execute({ propertyId: 'missing-property' }, baseContext)

    expect(result).toMatchObject({ status: 'failed', data: null, failure: { code: 'not_found', retryable: false } })
    expect(mocks.getPropertySnapshot).not.toHaveBeenCalled()
    expect(mocks.listEngineeringProjects).not.toHaveBeenCalled()
  })

  it('returns a safe unavailable failure instead of throwing on a storage error', async () => {
    mocks.resolveFounderPropertyWorkspaceId.mockResolvedValue('workspace-a')
    mocks.getPropertySnapshot.mockRejectedValue(new Error('db down'))
    mocks.listEngineeringProjects.mockResolvedValue([])

    const result = await propertySnapshotCapability.execute({ propertyId: 'property-1' }, baseContext)

    expect(result).toMatchObject({ status: 'failed', failure: { code: 'unavailable', retryable: true } })
  })

  it('never leaks the authenticated founder user id into the result', async () => {
    mocks.resolveFounderPropertyWorkspaceId.mockResolvedValue('workspace-a')
    mocks.getPropertySnapshot.mockResolvedValue(rawSnapshot)
    mocks.listEngineeringProjects.mockResolvedValue(rawProjects)

    const result = await propertySnapshotCapability.execute({ propertyId: 'property-1' }, {
      ...baseContext,
      actor: { kind: 'founder', userId: 'private-founder-id' },
    })

    expect(JSON.stringify(result)).not.toContain('private-founder-id')
  })

  describe('adversarial: raw durable-storage content cannot cross the public output boundary', () => {
    const poisonedSnapshot = {
      property: {
        id: 'property-1',
        name: 'Bimini Villa',
        property_type: 'residential',
        location_label: 'North Bimini',
        status: 'active',
        metadata: {
          internal_storage_path: 's3://caye-internal-bucket/founder/secret.json',
          service_role_key: 'sb_secret_abc123',
          workspace_id: 'workspace-real-internal-id',
        },
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      },
      structures: [{
        id: 'structure-1',
        name: 'Main House',
        structure_type: 'building',
        metadata: { internal_note: 'auth_token=sk-internal-leak-marker', storage_path: '/var/caye/private/structure-1.json' },
      }],
      systems: [{
        id: 'system-1',
        structure_id: 'structure-1',
        name: 'Well pump',
        system_type: 'water',
        status: 'active',
        metadata: { internal_debug_key: 'INTERNAL_LEAK_MARKER', supabase_service_key: 'sb_secret_xyz' },
      }],
      assets: [{
        id: 'asset-1',
        structure_id: 'structure-1',
        system_id: 'system-1',
        name: 'Pump motor',
        asset_type: 'pump',
        manufacturer: 'Grundfos',
        model: 'CR3',
        status: 'operational',
        specifications: { internal_path: '/internal/blob/asset-1', auth_claim: 'role=service_role', secret: 'INTERNAL_LEAK_MARKER' },
      }],
      current_observations: [{
        id: 'obs-1',
        structure_id: null,
        system_id: 'system-1',
        asset_id: null,
        observation_key: 'flow_rate',
        numeric_value: 12,
        text_value: null,
        unit: 'gpm',
        provenance_status: 'measured',
        confidence: 0.9,
        observed_at: '2026-01-03T00:00:00Z',
        created_at: '2026-01-03T00:00:00Z',
        notes: null,
      }],
      observations: [],
    }

    it('strips structures[].metadata, systems[].metadata, and assets[].specifications entirely', async () => {
      mocks.resolveFounderPropertyWorkspaceId.mockResolvedValue('workspace-a')
      mocks.getPropertySnapshot.mockResolvedValue(poisonedSnapshot)
      mocks.listEngineeringProjects.mockResolvedValue([])

      const result = await propertySnapshotCapability.execute({ propertyId: 'property-1' }, baseContext)

      expect(result.status).toBe('observed')
      const serialized = JSON.stringify(result.data)
      expect(serialized).not.toContain('INTERNAL_LEAK_MARKER')
      expect(serialized).not.toContain('sb_secret')
      expect(serialized).not.toContain('s3://')
      expect(serialized).not.toContain('/var/caye/private')
      expect(serialized).not.toContain('/internal/blob')
      expect(serialized).not.toContain('auth_token')
      expect(serialized).not.toContain('auth_claim')
      expect(serialized).not.toContain('service_role')
      expect(serialized).not.toContain('workspace-real-internal-id')
      // The keys themselves must not appear either, not just marker values.
      expect(result.data).not.toHaveProperty('property.metadata')
      expect((result.data?.structures[0] as Record<string, unknown>)).not.toHaveProperty('metadata')
      expect((result.data?.systems[0] as Record<string, unknown>)).not.toHaveProperty('metadata')
      expect((result.data?.assets[0] as Record<string, unknown>)).not.toHaveProperty('specifications')
    })

    it('never emits internal record ids (structure/system/asset/observation/project) in data, only in evidence', async () => {
      mocks.resolveFounderPropertyWorkspaceId.mockResolvedValue('workspace-a')
      mocks.getPropertySnapshot.mockResolvedValue(poisonedSnapshot)
      mocks.listEngineeringProjects.mockResolvedValue(rawProjects)

      const result = await propertySnapshotCapability.execute({ propertyId: 'property-1' }, baseContext)

      const serialized = JSON.stringify(result.data)
      for (const internalId of ['structure-1', 'system-1', 'asset-1', 'obs-1', 'project-1']) {
        expect(serialized).not.toContain(internalId)
      }
      // The one deliberate public selector is the property id itself.
      expect(result.data?.property.id).toBe('property-1')
      // Evidence is allowed to retain internal record ids.
      expect(result.evidence.map((e) => e.id)).toEqual(expect.arrayContaining(['structure-1', 'system-1', 'asset-1', 'obs-1', 'project-1']))
    })
  })
})
