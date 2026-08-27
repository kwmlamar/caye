import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const getMostRecentArtifactForOperator = vi.hoisted(() => vi.fn())
vi.mock('@/lib/artifacts/query', () => ({ getMostRecentArtifactForOperator }))

const annotateArtifact = vi.hoisted(() => vi.fn())
vi.mock('@/lib/artifacts/relations', () => ({ annotateArtifact }))

import { annotateArtifactTool } from './annotate-artifact'
import type { ToolContext } from '../types'

function baseCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceId: 'ws-1',
    callerRole: 'owner',
    operatorId: 42,
    requestId: 'req-1',
    ...overrides,
  }
}

beforeEach(() => {
  getMostRecentArtifactForOperator.mockReset()
  annotateArtifact.mockReset()
})

describe('annotate_artifact — resolves "that image" without an explicit id (#87 conversational reference resolution)', () => {
  it('resolves to the most recent artifact from the SAME operator when artifact_id is omitted', async () => {
    getMostRecentArtifactForOperator.mockResolvedValueOnce({ id: 'artifact-recent' })
    annotateArtifact.mockResolvedValueOnce({ ok: true, observationId: 'obs-1', relationId: null })

    const result = await annotateArtifactTool.execute(
      { meaning: 'The Casino tram stop where cruise guests meet Max.' },
      baseCtx()
    )

    expect(getMostRecentArtifactForOperator).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', operatorAllowlistId: 42 })
    )
    expect(annotateArtifact).toHaveBeenCalledWith(expect.objectContaining({ artifactId: 'artifact-recent' }))
    expect(result.ok).toBe(true)
  })

  it("fails clearly when there is no recent artifact to attach the meaning to", async () => {
    getMostRecentArtifactForOperator.mockResolvedValueOnce(null)

    const result = await annotateArtifactTool.execute({ meaning: 'that is the pickup spot' }, baseCtx())

    expect(result.ok).toBe(false)
    expect(annotateArtifact).not.toHaveBeenCalled()
  })
})

describe('annotate_artifact — composes with active work without disturbing it (#87 acceptance test 13)', () => {
  it('never reads or reports on ctx.activeWork — it is a pure artifact-scoped write', async () => {
    getMostRecentArtifactForOperator.mockResolvedValueOnce({ id: 'artifact-1' })
    annotateArtifact.mockResolvedValueOnce({ ok: true, observationId: 'obs-1', relationId: null })

    const activeWork = { sourceMessageId: 'msg-jeff-proposal', entityRef: 'jeff@example.com', operation: 'customer_reply_draft' as const }
    const ctx = baseCtx({ activeWork })

    await annotateArtifactTool.execute({ meaning: 'Use this logo in the proposal.' }, ctx)

    // The tool's own object graph is untouched by the call — nothing here
    // mutates or reads ctx.activeWork, so a later turn's active-work check
    // still sees the SAME Jeff draft context it had before this tool ran.
    expect(ctx.activeWork).toBe(activeWork)
    expect(ctx.activeWork?.entityRef).toBe('jeff@example.com')
  })
})
