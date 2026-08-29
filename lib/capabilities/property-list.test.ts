import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listFounderProperties: vi.fn(),
}))

vi.mock('@/lib/property/store', () => ({
  listFounderProperties: mocks.listFounderProperties,
}))

import { propertyListCapability } from './property-list'

const baseContext = {
  actor: { kind: 'founder' as const, userId: 'founder-1' },
  scope: { workspaceId: null },
  caller: 'external_reasoner' as const,
}

describe('property.list capability', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns only founder-safe selection fields — no workspace/status/internal detail', async () => {
    mocks.listFounderProperties.mockResolvedValue([
      { id: 'property-1', name: 'Bimini Villa', location_label: 'North Bimini', status: 'active', workspace_id: 'workspace-real' },
    ])

    const result = await propertyListCapability.execute({}, baseContext)

    expect(result.status).toBe('observed')
    expect(result.data).toEqual([{ id: 'property-1', name: 'Bimini Villa', locationLabel: 'North Bimini' }])
    expect(JSON.stringify(result.data)).not.toContain('workspace-real')
    expect(JSON.stringify(result.data)).not.toContain('active')
  })

  it('never workspace-scopes the read — a caller-supplied workspaceId cannot narrow or redirect the list', async () => {
    mocks.listFounderProperties.mockResolvedValue([{ id: 'property-1', name: 'Bimini Villa', location_label: null, status: 'active' }])

    await propertyListCapability.execute({}, { ...baseContext, scope: { workspaceId: 'attacker-supplied-workspace' } })

    expect(mocks.listFounderProperties).toHaveBeenCalledWith()
  })

  it('distinguishes an empty founder property set from a failed read', async () => {
    mocks.listFounderProperties.mockResolvedValue([])
    const empty = await propertyListCapability.execute({}, baseContext)
    expect(empty).toMatchObject({ status: 'observed', data: [], failure: null })

    mocks.listFounderProperties.mockRejectedValue(new Error('db down'))
    const failed = await propertyListCapability.execute({}, baseContext)
    expect(failed).toMatchObject({ status: 'failed', failure: { code: 'unavailable', retryable: true } })
  })

  it('never leaks the authenticated founder user id into the result', async () => {
    mocks.listFounderProperties.mockResolvedValue([{ id: 'property-1', name: 'Bimini Villa', location_label: null, status: 'active' }])

    const result = await propertyListCapability.execute({}, { ...baseContext, actor: { kind: 'founder', userId: 'private-founder-id' } })

    expect(JSON.stringify(result)).not.toContain('private-founder-id')
  })

  it('returns the property id as the deliberate public selector for property.snapshot, evidenced by record refs', async () => {
    mocks.listFounderProperties.mockResolvedValue([{ id: 'property-1', name: 'Bimini Villa', location_label: null, status: 'active' }])

    const result = await propertyListCapability.execute({}, baseContext)

    expect(result.data?.[0]?.id).toBe('property-1')
    expect(result.evidence).toEqual([{ kind: 'record', id: 'property-1' }])
  })
})
