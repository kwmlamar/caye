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

  it('returns founder-safe structured state with evidence and distinguishes provenance', async () => {
    mocks.resolveFounderPropertyWorkspaceId.mockResolvedValue('workspace-a')
    mocks.getPropertySnapshot.mockResolvedValue(rawSnapshot)
    mocks.listEngineeringProjects.mockResolvedValue(rawProjects)

    const result = await propertySnapshotCapability.execute({ propertyId: 'property-1' }, baseContext)

    expect(result.status).toBe('observed')
    expect(result.data).toMatchObject({
      property: { id: 'property-1', name: 'Bimini Villa', propertyType: 'residential', locationLabel: 'North Bimini', status: 'active' },
      structures: [{ id: 'structure-1', name: 'Main House', structureType: 'building' }],
      systems: [
        expect.objectContaining({ id: 'system-1', status: 'active' }),
        expect.objectContaining({ id: 'system-2', status: 'needs_attention' }),
      ],
      currentObservations: [expect.objectContaining({ key: 'flow_rate', provenanceStatus: 'measured', numericValue: 12 })],
      projects: [expect.objectContaining({ id: 'project-1', name: 'Cistern rehab' })],
      openIssues: [
        { kind: 'system', id: 'system-2', name: 'Cistern', status: 'needs_attention' },
        { kind: 'asset', id: 'asset-2', name: 'Cistern liner', status: 'unknown' },
      ],
    })
    expect(result.evidence).toContainEqual({ kind: 'record', id: 'property-1' })
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
})
