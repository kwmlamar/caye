import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  goalsExecute: vi.fn(),
  attentionExecute: vi.fn(),
  engineeringExecute: vi.fn(),
  writeExecute: vi.fn(),
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
    ])
    expect(manifest.every((item) => !('execute' in item))).toBe(true)
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
