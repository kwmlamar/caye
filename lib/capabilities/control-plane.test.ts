import { describe, expect, it } from 'vitest'
import { capabilityCoverage, conversationalCapabilityManifest } from './control-plane'
import { cayeCapabilitiesTool } from '@/lib/caye-agent/tools/read/caye-capabilities'
import { startCanonicalResearchTool } from '@/lib/caye-agent/tools/write-low/start-canonical-research'
import { selectToolSurface } from '@/lib/caye-agent/execute'
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
      available: true,
      unavailableReason: null,
    })
  })

  it('reports executable conversational coverage separately from canonical registration', () => {
    const coverage = capabilityCoverage()
    for (const domain of coverage) {
      expect(domain.registeredCapabilityCount).toBeGreaterThanOrEqual(domain.capabilityCount)
      expect(domain.registeredCapabilityCount).toBe(
        domain.capabilityCount + domain.unavailableCapabilityCount,
      )
    }

    const research = coverage.find((entry) => entry.domain === 'research')
    expect(research?.writeCount).toBe(1)
    expect(research?.capabilities).toContain('research.start')
  })

  it('exposes real coverage and explicit future gaps for device domains', () => {
    const coverage = capabilityCoverage()
    expect(coverage.find((entry) => entry.domain === 'research')?.capabilityCount).toBeGreaterThan(0)
    expect(coverage.find((entry) => entry.domain === 'properties')?.capabilityCount).toBeGreaterThan(0)
    expect(coverage.find((entry) => entry.domain === 'perception')).toMatchObject({ status: 'active' })
    expect(coverage.find((entry) => entry.domain === 'perception')?.capabilities).toContain('perception.status')
    expect(coverage.find((entry) => entry.domain === 'business_operations')?.capabilities).not.toContain('perception.status')
    expect(coverage.find((entry) => entry.domain === 'computers')).toMatchObject({ status: 'future', capabilityCount: 0 })
    expect(coverage.find((entry) => entry.domain === 'iot')).toMatchObject({ status: 'future', capabilityCount: 0 })
    expect(coverage.find((entry) => entry.domain === 'robots_machines')).toMatchObject({ status: 'future', capabilityCount: 0 })
  })

  it('keeps canonical read and write authority structurally separate', () => {
    expect(cayeCapabilitiesTool.risk).toBe('read')
    expect(startCanonicalResearchTool.risk).toBe('low')
    expect(cayeCapabilitiesTool.name).not.toBe(startCanonicalResearchTool.name)
  })

  it('excludes the low-risk canonical write from read-only continuation surfaces', () => {
    const surface = selectToolSurface({
      tools: [cayeCapabilitiesTool, startCanonicalResearchTool] as never[],
      mode: 'back-office',
      readOnly: true,
      ctx: dashboardContext(),
    })

    expect(surface.tools.map((tool) => tool.name)).toEqual(['caye_capabilities'])
    expect(surface.metrics.excludedByReadOnlyCount).toBe(1)
  })

  it('fails closed when verified founder identity is absent', async () => {
    const result = await cayeCapabilitiesTool.execute(
      { action: 'invoke', capability: 'goals.list' },
      dashboardContext(),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Verified founder identity')
  })

  it('discovers only read capabilities on founder Direct with verified identity', async () => {
    const context = dashboardContext()
    Object.assign(context, { founderUserId: 'founder-user-1' })
    const result = await cayeCapabilitiesTool.execute({ action: 'discover' }, context)
    expect(result.ok).toBe(true)
    const data = result.data as { capabilities: ReturnType<typeof conversationalCapabilityManifest> }
    expect(data.capabilities.some((entry) => entry.name === 'property.list')).toBe(true)
    expect(data.capabilities.some((entry) => entry.name === 'job_search.summary')).toBe(true)
    expect(data.capabilities.some((entry) => entry.name === 'perception.status')).toBe(true)
    expect(data.capabilities.every((entry) => entry.access === 'read')).toBe(true)
    expect(data.capabilities.some((entry) => entry.name === 'research.start')).toBe(false)
  })

  it('refuses write capabilities through the read bridge', async () => {
    const context = dashboardContext()
    Object.assign(context, { founderUserId: 'founder-user-1' })
    const result = await cayeCapabilitiesTool.execute({
      action: 'invoke',
      capability: 'research.start',
      args: { questionId: 'question-1' },
    }, context)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('write capability')
  })

  it('fails closed for the low-risk write when verified founder identity is absent', async () => {
    const result = await startCanonicalResearchTool.execute(
      { questionId: 'question-1' },
      dashboardContext(),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Verified founder identity')
  })

  it('does not expose canonical bridges on ordinary back-office channels', async () => {
    const context = dashboardContext()
    delete (context as { channel?: 'dashboard' }).channel
    Object.assign(context, { founderUserId: 'founder-user-1' })

    const readResult = await cayeCapabilitiesTool.execute({ action: 'discover' }, context)
    expect(readResult.ok).toBe(false)
    expect(readResult.error).toContain('founder Caye Direct')

    const writeResult = await startCanonicalResearchTool.execute({ questionId: 'question-1' }, context)
    expect(writeResult.ok).toBe(false)
    expect(writeResult.error).toContain('founder Caye Direct')
  })
})
