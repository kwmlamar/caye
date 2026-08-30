import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  buildFounderContextSnapshot: vi.fn(),
  invokeFounderReadCapability: vi.fn(),
  invokeFounderResearchStartCapability: vi.fn(),
}))

vi.mock('@/lib/capabilities/gateway', () => ({
  buildFounderContextSnapshot: mocks.buildFounderContextSnapshot,
  invokeFounderReadCapability: mocks.invokeFounderReadCapability,
  invokeFounderResearchStartCapability: mocks.invokeFounderResearchStartCapability,
}))

import { CAYE_MCP_TOOLS, callCayeMcpTool, mcpToolsListResult } from './protocol'

const observed = { status:'observed' as const, data:[{id:'goal-1'}], evidence:[{kind:'record' as const,id:'goal-1'}], executionRef:null, auditRef:null, failure:null }
const staged = { status:'staged' as const, data:{id:'run-1',question_id:'question-1',status:'queued'}, evidence:[{kind:'record' as const,id:'research_run:run-1'}], executionRef:null, auditRef:'research_run:run-1', failure:null }

describe('Caye MCP protocol adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invokeFounderReadCapability.mockResolvedValue(observed)
    mocks.invokeFounderResearchStartCapability.mockResolvedValue(staged)
    mocks.buildFounderContextSnapshot.mockResolvedValue({actor:{kind:'founder'},scope:{workspaceId:'workspace-a'},capabilities:[],observations:{goals:observed,attention:null,engineeringArtifacts:null}})
  })

  it('publishes the bounded tools in deterministic order and keeps research start non-destructive', () => {
    expect(CAYE_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      'caye_context_snapshot','caye_goals_list','caye_attention_list','caye_engineering_artifacts_list','caye_property_list','caye_property_snapshot',
      'caye_research_status','caye_research_claims','caye_research_brief','caye_research_start',
    ])
    expect(CAYE_MCP_TOOLS.filter((tool)=>tool.name!=='caye_research_start').every((tool)=>tool.annotations.readOnlyHint===true)).toBe(true)
    const start = CAYE_MCP_TOOLS.find((tool)=>tool.name==='caye_research_start')
    expect(start?.annotations).toMatchObject({readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false})
    expect(CAYE_MCP_TOOLS.every((tool)=>tool.annotations.destructiveHint===false)).toBe(true)
    expect(mcpToolsListResult().tools).toEqual(CAYE_MCP_TOOLS)
  })

  it('maps MCP workspace scope into trusted gateway scope, not capability args', async () => {
    const result=await callCayeMcpTool('founder-user','caye_attention_list',{workspaceId:'workspace-a'})
    expect(mocks.invokeFounderReadCapability).toHaveBeenCalledWith('founder-user',{capability:'attention.list',version:1,workspaceId:'workspace-a',args:{}})
    expect(result?.structuredContent).toEqual({result:observed})
  })

  it.each([
    ['caye_research_status','research.status'],['caye_research_claims','research.claims'],['caye_research_brief','research.brief'],
  ])('routes operator-scoped research read %s through the read-only gateway', async (tool,capability) => {
    const result=await callCayeMcpTool('founder-user',tool,{})
    expect(mocks.invokeFounderReadCapability).toHaveBeenCalledWith('founder-user',{capability,version:1,workspaceId:null,args:{}})
    expect(result?.isError).toBe(false)
  })

  it('routes research start only through the narrow staged-write gateway', async () => {
    const result=await callCayeMcpTool('founder-user','caye_research_start',{questionId:' question-1 '})
    expect(mocks.invokeFounderResearchStartCapability).toHaveBeenCalledWith('founder-user',{capability:'research.start',version:1,workspaceId:null,args:{questionId:'question-1'}})
    expect(mocks.invokeFounderReadCapability).not.toHaveBeenCalled()
    expect(result?.structuredContent).toEqual({result:staged})
    expect(result?.isError).toBe(false)
  })

  it('rejects extra research-start arguments rather than turning them into authority', async () => {
    const result=await callCayeMcpTool('founder-user','caye_research_start',{questionId:'question-1',workspaceId:'customer-workspace'})
    expect(result?.isError).toBe(true)
    expect(mocks.invokeFounderResearchStartCapability).not.toHaveBeenCalled()
  })

  it('rejects extra tool arguments instead of forwarding them', async () => {
    const result=await callCayeMcpTool('founder-user','caye_goals_list',{workspaceId:'workspace-a',actor:{userId:'spoofed'}})
    expect(result?.isError).toBe(true); expect(mocks.invokeFounderReadCapability).not.toHaveBeenCalled()
  })

  it('requires workspace scope for workspace-only capabilities', async () => {
    const result=await callCayeMcpTool('founder-user','caye_engineering_artifacts_list',{})
    expect(result?.isError).toBe(true); expect(mocks.invokeFounderReadCapability).not.toHaveBeenCalled()
  })

  it('preserves failed capability status and tool error state', async () => {
    const failed={status:'failed' as const,data:null,evidence:[],executionRef:null,auditRef:'audit-1',failure:{code:'unavailable' as const,message:'State unavailable',retryable:true}}
    mocks.invokeFounderReadCapability.mockResolvedValue(failed)
    const result=await callCayeMcpTool('founder-user','caye_goals_list',{})
    expect(result?.isError).toBe(true); expect(result?.structuredContent).toEqual({result:failed})
  })

  it('keeps founder identity out of the context snapshot transport', async () => {
    const result=await callCayeMcpTool('private-founder-id','caye_context_snapshot',{workspaceId:'workspace-a'})
    expect(mocks.buildFounderContextSnapshot).toHaveBeenCalledWith('private-founder-id','workspace-a')
    expect(JSON.stringify(result)).not.toContain('private-founder-id')
  })

  it('returns null for tools outside the fixed MCP catalog', async () => {
    expect(await callCayeMcpTool('founder-user','raw_sql',{})).toBeNull()
  })

  it('routes property snapshot with canonical propertyId, not workspace scope', async () => {
    const result=await callCayeMcpTool('founder-user','caye_property_snapshot',{propertyId:'property-1'})
    expect(mocks.invokeFounderReadCapability).toHaveBeenCalledWith('founder-user',{capability:'property.snapshot',version:1,workspaceId:null,propertyId:'property-1'})
    expect(result?.isError).toBe(false)
  })

  it('fails closed when property snapshot is missing its selector', async () => {
    const result=await callCayeMcpTool('founder-user','caye_property_snapshot',{})
    expect(result?.isError).toBe(true); expect(mocks.invokeFounderReadCapability).not.toHaveBeenCalled()
  })

  it('property discovery accepts no arguments and rejects smuggled workspace scope', async () => {
    for (const args of [undefined,{},null]) expect((await callCayeMcpTool('founder-user','caye_property_list',args))?.isError).toBe(false)
    vi.clearAllMocks()
    const bad=await callCayeMcpTool('founder-user','caye_property_list',{workspaceId:'workspace-a'})
    expect(bad?.isError).toBe(true); expect(mocks.invokeFounderReadCapability).not.toHaveBeenCalled()
  })
})
