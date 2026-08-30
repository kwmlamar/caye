import { describe, expect, it } from 'vitest'
import { capabilityCoverage, conversationalCapabilityManifest } from './control-plane'
import { cayeCapabilitiesTool } from '@/lib/caye-agent/tools/read/caye-capabilities'
import type { ToolContext } from '@/lib/caye-agent/tools/types'

function dashboardContext(extra: Record<string, unknown> = {}): ToolContext {
  return {
    workspaceId: 'workspace-1',
    callerRole: 'founder',
    operatorId: 1,
    requestId: 'request-1',
    channel: 'dashboard',
    ...extra,
  } as ToolContext
}

describe('conversational capability control plane', () => {
  it('publishes typed versioned access, risk, approval, scope, and schema metadata', () => {
    const manifest = conversationalCapabilityManifest()
    expect(manifest.length).toBeGreaterThan(3)

    const goals = manifest.find((entry) => entry.name === 'goals.list')
    expect(goals).toMatchObject({
      version: 1,
      access: 'read',
      risk: 'read_only',
      approvalRequirement: 'none',
      scopeMode: 'either',
      available: true,
    })
    expect(goals?.inputSchemaId).toBeTruthy()
    expect(goals?.outputSchemaId).toBeTruthy()

    const researchStart = manifest.find((entry) => entry.name === 'research.start')
    expect(researchStart).toMatchObject({
      access: 'write',
      risk: 'low',
      approvalRequirement: 'none',
      scopeMode: 'operator',
    })
  })

  it('exposes real coverage and explicit future gaps for device domains', () => {
    const coverage = capabilityCoverage()
    expect(coverage.find((entry) => entry.domain === 'research')?.capabilityCount).toBeGreaterThan(0)
    expect(coverage.find((entry) => entry.domain === 'properties')?.capabilityCount).toBeGreaterThan(0)
    expect(coverage.find((entry) => entry.domain === 'computers')).toMatchObject({ status: 'future', capabilityCount: 0 })
    expect(coverage.find((entry) => entry.domain === 'iot')).toMatchObject({ status: 'future', capabilityCount: 0 })
    expect(coverage.find((entry) => entry.domain === 'robots_machines')).toMatchObject({ status: 'future', capabilityCount: 0 })
  })

  it('fails closed when verified founder identity is absent', async () => {
    const result = await cayeCapabilitiesTool.execute(
      { action: 'invoke', capability: 'goals.list' },
      dashboardContext(),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Verified founder identity')
  })

  it('discovers capabilities only on founder Direct with verified identity', async () => {
    const context = dashboardContext()
    Object.assign(context, { founderUserId: 'founder-user-1' })
    const result = await cayeCapabilitiesTool.execute({ action: 'discover' }, context)
    expect(result.ok).toBe(true)
    const data = result.data as { capabilities: ReturnType<typeof conversationalCapabilityManifest> }
    expect(data.capabilities.some((entry) => entry.name === 'property.list')).toBe(true)
    expect(data.capabilities.some((entry) => entry.name === 'job_search.summary')).toBe(true)
    expect(data.capabilities.some((entry) => entry.name === 'research.start')).toBe(true)
  })

  it('does not expose the bridge on ordinary back-office channels', async () => {
    const context = dashboardContext()
    delete (context as { channel?: 'dashboard' }).channel
    Object.assign(context, { founderUserId: 'founder-user-1' })
    const result = await cayeCapabilitiesTool.execute({ action: 'discover' }, context)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('founder Caye Direct')
  })
})
