import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  goalsExecute: vi.fn(),
  attentionExecute: vi.fn(),
  engineeringExecute: vi.fn(),
  writeExecute: vi.fn(),
  propertySnapshotExecute: vi.fn(),
  propertyListExecute: vi.fn(),
}))

vi.mock('./catalog', () => ({
  cayeCapabilityRegistry: new Map([
    ['goals.list', {
      manifest: {
        name: 'goals.list', version: 1, namespace: 'goals', description: 'goals',
        access: 'read', risk: 'read_only', inputSchemaId: 'in', outputSchemaId: 'out',
      },
      execute: mocks.goalsExecute,
    }],
    ['attention.list', {
      manifest: {
        name: 'attention.list', version: 1, namespace: 'attention', description: 'attention',
        access: 'read', risk: 'read_only', inputSchemaId: 'in', outputSchemaId: 'out',
      },
      execute: mocks.attentionExecute,
    }],
    ['engineering.artifacts.list', {
      manifest: {
        name: 'engineering.artifacts.list', version: 1, namespace: 'engineering', description: 'engineering',
        access: 'read', risk: 'read_only', inputSchemaId: 'in', outputSchemaId: 'out',
      },
      execute: mocks.engineeringExecute,
    }],
    ['goals.write-test', {
      manifest: {
        name: 'goals.write-test', version: 1, namespace: 'goals', description: 'write',
        access: 'write', risk: 'consequential', inputSchemaId: 'in', outputSchemaId: 'out',
      },
      execute: mocks.writeExecute,
    }],
    ['property.snapshot', {
      manifest: {
        name: 'property.snapshot', version: 1, namespace: 'property', description: 'property',
        access: 'read', risk: 'read_only', inputSchemaId: 'in', outputSchemaId: 'out',
      },
      execute: mocks.propertySnapshotExecute,
    }],
    ['property.list', {
      manifest: {
        name: 'property.list', version: 1, namespace: 'property', description: 'property list',
        access: 'read', risk: 'read_only', inputSchemaId: 'in', outputSchemaId: 'out',
      },
      execute: mocks.propertyListExecute,
    }],
  ]),
}))

import { buildFounderContextSnapshot, founderCapabilityManifest, invokeFounderReadCapability } from './gateway'

const observed = (data: unknown = []) => ({
  status: 'observed' as const,
  data,
  evidence: [],
  executionRef: null,
  auditRef: null,
  failure: null,
})

describe('founder capability gateway service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.goalsExecute.mockResolvedValue(observed([{ id: 'goal-1' }]))
    mocks.attentionExecute.mockResolvedValue(observed([{ id: 'attention-1' }]))
    mocks.engineeringExecute.mockResolvedValue(observed([{ id: 'artifact-1' }]))
  })

  it('injects trusted founder identity, workspace scope, and external caller class', async () => {
    const result = await invokeFounderReadCapability('trusted-founder', {
      capability: 'goals.list',
      version: 1,
      workspaceId: 'workspace-a',
      args: {},
    })

    expect(result.status).toBe('observed')
    expect(mocks.goalsExecute).toHaveBeenCalledWith({}, {
      actor: { kind: 'founder', userId: 'trusted-founder' },
      scope: { workspaceId: 'workspace-a' },
      caller: 'external_reasoner',
    })
  })

  it('rejects unknown capabilities and non-empty model args', async () => {
    const missing = await invokeFounderReadCapability('founder', {
      capability: 'property.raw_sql',
      version: 1,
      workspaceId: null,
    })
    expect(missing).toMatchObject({ status: 'failed', failure: { code: 'not_found' } })

    const args = await invokeFounderReadCapability('founder', {
      capability: 'goals.list',
      version: 1,
      workspaceId: null,
      args: { workspaceId: 'smuggled-workspace' },
    })
    expect(args).toMatchObject({ status: 'failed', failure: { code: 'invalid_args' } })
    expect(mocks.goalsExecute).not.toHaveBeenCalled()
  })

  it('refuses registered write capabilities at the gateway boundary', async () => {
    const result = await invokeFounderReadCapability('founder', {
      capability: 'goals.write-test',
      version: 1,
      workspaceId: null,
    })

    expect(result).toMatchObject({ status: 'failed', failure: { code: 'unavailable' } })
    expect(mocks.writeExecute).not.toHaveBeenCalled()
  })

  it('keeps private handlers out of the public manifest', () => {
    const manifest = founderCapabilityManifest()
    expect(manifest.map((item) => item.name)).toEqual([
      'attention.list',
      'engineering.artifacts.list',
      'goals.list',
      'goals.write-test',
      'property.list',
      'property.snapshot',
    ])
    expect(manifest.every((item) => !('execute' in item))).toBe(true)
  })

  it('resolves property.list with no args and no workspace scope, for fresh-session discovery', async () => {
    mocks.propertyListExecute.mockResolvedValue(observed([{ id: 'property-1', name: 'Bimini Villa' }]))

    const result = await invokeFounderReadCapability('trusted-founder', {
      capability: 'property.list',
      version: 1,
      workspaceId: null,
      args: {},
    })

    expect(result.status).toBe('observed')
    expect(mocks.propertyListExecute).toHaveBeenCalledWith({}, {
      actor: { kind: 'founder', userId: 'trusted-founder' },
      scope: { workspaceId: null },
      caller: 'external_reasoner',
    })
  })

  it('accepts propertyId only for a capability that declares an id-scoped selector', async () => {
    mocks.propertySnapshotExecute.mockResolvedValue(observed({ property: { id: 'property-1' } }))

    const result = await invokeFounderReadCapability('trusted-founder', {
      capability: 'property.snapshot',
      version: 1,
      workspaceId: null,
      propertyId: 'property-1',
    })

    expect(result.status).toBe('observed')
    expect(mocks.propertySnapshotExecute).toHaveBeenCalledWith({ propertyId: 'property-1' }, {
      actor: { kind: 'founder', userId: 'trusted-founder' },
      scope: { workspaceId: null },
      caller: 'external_reasoner',
    })
  })

  it('fails closed when property.snapshot is invoked without a propertyId', async () => {
    const result = await invokeFounderReadCapability('founder', {
      capability: 'property.snapshot',
      version: 1,
      workspaceId: null,
    })

    expect(result).toMatchObject({ status: 'failed', failure: { code: 'invalid_args' } })
    expect(mocks.propertySnapshotExecute).not.toHaveBeenCalled()
  })

  it('ignores a caller-supplied workspaceId for property.snapshot rather than using it as authority', async () => {
    mocks.propertySnapshotExecute.mockResolvedValue(observed({ property: { id: 'property-1' } }))

    await invokeFounderReadCapability('trusted-founder', {
      capability: 'property.snapshot',
      version: 1,
      workspaceId: 'attacker-supplied-workspace',
      propertyId: 'property-1',
    })

    expect(mocks.propertySnapshotExecute).toHaveBeenCalledWith({ propertyId: 'property-1' }, expect.objectContaining({
      scope: { workspaceId: 'attacker-supplied-workspace' },
    }))
  })

  it('rejects propertyId for a capability that does not declare an id-scoped selector', async () => {
    const result = await invokeFounderReadCapability('founder', {
      capability: 'goals.list',
      version: 1,
      workspaceId: null,
      propertyId: 'smuggled-property',
    })

    expect(result).toMatchObject({ status: 'failed', failure: { code: 'invalid_args' } })
    expect(mocks.goalsExecute).not.toHaveBeenCalled()
  })

  it('builds a fresh-session snapshot without exposing the founder auth id', async () => {
    const snapshot = await buildFounderContextSnapshot('private-founder-id', 'workspace-a')

    expect(snapshot.actor).toEqual({ kind: 'founder' })
    expect(snapshot.scope).toEqual({ workspaceId: 'workspace-a' })
    expect(snapshot.observations.goals.status).toBe('observed')
    expect(snapshot.observations.attention?.status).toBe('observed')
    expect(snapshot.observations.engineeringArtifacts?.status).toBe('observed')
    expect(JSON.stringify(snapshot)).not.toContain('private-founder-id')
  })

  it('does not attempt workspace-only reads in operator scope', async () => {
    const snapshot = await buildFounderContextSnapshot('founder', null)

    expect(snapshot.observations.attention).toBeNull()
    expect(snapshot.observations.engineeringArtifacts).toBeNull()
    expect(mocks.attentionExecute).not.toHaveBeenCalled()
    expect(mocks.engineeringExecute).not.toHaveBeenCalled()
  })
})
