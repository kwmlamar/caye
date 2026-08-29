import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireFounder: vi.fn(),
  buildFounderContextSnapshot: vi.fn(),
  founderCapabilityManifest: vi.fn(),
  invokeFounderReadCapability: vi.fn(),
}))

vi.mock('@/lib/founder', () => ({ requireFounder: mocks.requireFounder }))
vi.mock('@/lib/capabilities/gateway', () => ({
  buildFounderContextSnapshot: mocks.buildFounderContextSnapshot,
  founderCapabilityManifest: mocks.founderCapabilityManifest,
  invokeFounderReadCapability: mocks.invokeFounderReadCapability,
}))

import { GET, POST } from './route'

describe('founder capability gateway route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.founderCapabilityManifest.mockReturnValue([])
  })

  it('fails closed before exposing context to a non-founder', async () => {
    mocks.requireFounder.mockResolvedValue(null)
    const req = new NextRequest('http://localhost/api/founder/capabilities')

    const res = await GET(req)

    expect(res.status).toBe(403)
    expect(mocks.buildFounderContextSnapshot).not.toHaveBeenCalled()
  })

  it('builds operator scope when workspaceId is absent', async () => {
    mocks.requireFounder.mockResolvedValue({ id: 'founder-user-id' })
    mocks.buildFounderContextSnapshot.mockResolvedValue({
      actor: { kind: 'founder' },
      scope: { workspaceId: null },
      capabilities: [],
      observations: {},
    })
    const req = new NextRequest('http://localhost/api/founder/capabilities')

    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(mocks.buildFounderContextSnapshot).toHaveBeenCalledWith('founder-user-id', null)
    const json = await res.json()
    expect(JSON.stringify(json)).not.toContain('founder-user-id')
  })

  it('rejects an explicitly empty workspace id', async () => {
    mocks.requireFounder.mockResolvedValue({ id: 'founder-user-id' })
    const req = new NextRequest('http://localhost/api/founder/capabilities?workspaceId=')

    const res = await GET(req)

    expect(res.status).toBe(400)
    expect(mocks.buildFounderContextSnapshot).not.toHaveBeenCalled()
  })

  it('injects authenticated founder identity instead of accepting one from the caller', async () => {
    mocks.requireFounder.mockResolvedValue({ id: 'trusted-founder-id' })
    mocks.invokeFounderReadCapability.mockResolvedValue({
      status: 'observed',
      data: [],
      evidence: [],
      executionRef: null,
      auditRef: null,
      failure: null,
    })

    const req = new NextRequest('http://localhost/api/founder/capabilities', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: 'goals.list',
        version: 1,
        workspaceId: 'workspace-a',
        args: {},
        actor: { kind: 'founder', userId: 'attacker-supplied-id' },
        caller: 'internal_procedure',
      }),
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mocks.invokeFounderReadCapability).toHaveBeenCalledWith('trusted-founder-id', {
      capability: 'goals.list',
      version: 1,
      workspaceId: 'workspace-a',
      args: {},
    })
    expect(JSON.stringify(mocks.invokeFounderReadCapability.mock.calls[0])).not.toContain('attacker-supplied-id')
  })

  it('passes a caller-supplied propertyId through to the gateway for id-scoped capabilities', async () => {
    mocks.requireFounder.mockResolvedValue({ id: 'trusted-founder-id' })
    mocks.invokeFounderReadCapability.mockResolvedValue({
      status: 'observed',
      data: { property: { id: 'property-1' } },
      evidence: [],
      executionRef: null,
      auditRef: null,
      failure: null,
    })

    const req = new NextRequest('http://localhost/api/founder/capabilities', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capability: 'property.snapshot',
        version: 1,
        workspaceId: null,
        propertyId: 'property-1',
      }),
    })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mocks.invokeFounderReadCapability).toHaveBeenCalledWith('trusted-founder-id', {
      capability: 'property.snapshot',
      version: 1,
      workspaceId: null,
      propertyId: 'property-1',
      args: undefined,
    })
  })

  it('rejects a non-string propertyId before invoking the gateway', async () => {
    mocks.requireFounder.mockResolvedValue({ id: 'founder-user-id' })
    const req = new NextRequest('http://localhost/api/founder/capabilities', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'property.snapshot', version: 1, propertyId: 42 }),
    })

    const res = await POST(req)

    expect(res.status).toBe(400)
    expect(mocks.invokeFounderReadCapability).not.toHaveBeenCalled()
  })

  it('rejects malformed invocation requests before execution', async () => {
    mocks.requireFounder.mockResolvedValue({ id: 'founder-user-id' })
    const req = new NextRequest('http://localhost/api/founder/capabilities', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1 }),
    })

    const res = await POST(req)

    expect(res.status).toBe(400)
    expect(mocks.invokeFounderReadCapability).not.toHaveBeenCalled()
  })
})
