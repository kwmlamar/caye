import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  investigate: vi.fn(),
  start: vi.fn(),
}))

vi.mock('@/lib/capabilities/gateway', () => ({
  invokeFounderResearchInvestigateCapability: mocks.investigate,
  invokeFounderResearchStartCapability: mocks.start,
}))
vi.mock('server-only', () => ({}))

import { startCanonicalResearchTool } from './start-canonical-research'

function founderCtx(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'workspace-1',
    callerRole: 'founder',
    requestId: 'request-1',
    channel: 'dashboard',
    engineeringOrigin: { threadId: 'thread-1', messageId: 'message-1' },
    founderUserId: 'founder-auth-user-1',
    ...overrides,
  } as any
}

const staged = {
  status: 'staged',
  data: { durable: true, epistemicStatus: 'unverified_lead', questionId: 'q-1', runId: 'r-1' },
  evidence: [],
  executionRef: null,
  auditRef: 'research_question:q-1',
  failure: null,
}

describe('start_canonical_research ad-hoc founder investigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.investigate.mockResolvedValue(staged)
    mocks.start.mockResolvedValue(staged)
  })

  it('turns a look-into factual assertion into an unverified durable investigation', async () => {
    const result = await startCanonicalResearchTool.execute({
      lead: 'NVIDIA bought Hugging Face',
      verificationQuestion: 'Did NVIDIA acquire Hugging Face, and if so what exactly occurred?',
      canonicalKey: 'nvidia:hugging-face:acquisition',
      program: 'ai_global_technology',
    }, founderCtx())

    expect(result.ok).toBe(true)
    expect(mocks.investigate).toHaveBeenCalledWith(
      'founder-auth-user-1',
      { workspaceId: 'workspace-1', threadId: 'thread-1', messageId: 'message-1' },
      expect.objectContaining({
        capability: 'research.investigate',
        workspaceId: null,
        args: expect.objectContaining({
          lead: 'NVIDIA bought Hugging Face',
          verificationQuestion: 'Did NVIDIA acquire Hugging Face, and if so what exactly occurred?',
          canonicalKey: 'nvidia:hugging-face:acquisition',
        }),
      }),
    )
  })

  it('uses the trusted turn workspace for provenance, not a model supplied workspace', async () => {
    await startCanonicalResearchTool.execute({
      lead: 'Look into X',
      verificationQuestion: 'What is X, and what actually occurred?',
      canonicalKey: 'x:verification',
      program: 'wildcard_global_discovery',
    }, founderCtx({ workspaceId: 'workspace-authoritative' }))

    expect(mocks.investigate.mock.calls[0][1]).toEqual({
      workspaceId: 'workspace-authoritative',
      threadId: 'thread-1',
      messageId: 'message-1',
    })
  })

  it('keeps duplicate paraphrases on the same semantic canonical key', async () => {
    const ctx = founderCtx()
    await startCanonicalResearchTool.execute({
      lead: 'NVIDIA bought Hugging Face',
      verificationQuestion: 'Did NVIDIA acquire Hugging Face, and if so what exactly occurred?',
      canonicalKey: 'nvidia:hugging-face:acquisition',
      program: 'ai_global_technology',
    }, ctx)
    await startCanonicalResearchTool.execute({
      lead: 'I heard Hugging Face was acquired by NVIDIA',
      verificationQuestion: 'Was Hugging Face acquired by NVIDIA, and what were the actual terms?',
      canonicalKey: 'nvidia:hugging-face:acquisition',
      program: 'ai_global_technology',
    }, ctx)

    expect(mocks.investigate).toHaveBeenCalledTimes(2)
    expect(mocks.investigate.mock.calls.map((call) => call[2].args.canonicalKey)).toEqual([
      'nvidia:hugging-face:acquisition',
      'nvidia:hugging-face:acquisition',
    ])
  })

  it('refuses staff/customer paths even if called directly', async () => {
    const result = await startCanonicalResearchTool.execute({
      lead: 'Investigate this',
      verificationQuestion: 'What is true here?',
      canonicalKey: 'test:thing',
      program: 'wildcard_global_discovery',
    }, founderCtx({ callerRole: 'staff' }))

    expect(result.ok).toBe(false)
    expect(mocks.investigate).not.toHaveBeenCalled()
  })

  it('refuses non-Direct surfaces and missing verified founder identity', async () => {
    const nonDirect = await startCanonicalResearchTool.execute({ questionId: 'q-1' }, founderCtx({ channel: undefined }))
    const noIdentity = await startCanonicalResearchTool.execute({ questionId: 'q-1' }, founderCtx({ founderUserId: undefined }))

    expect(nonDirect.ok).toBe(false)
    expect(noIdentity.ok).toBe(false)
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('retains the existing questionId start path', async () => {
    const result = await startCanonicalResearchTool.execute({ questionId: 'question-existing' }, founderCtx())
    expect(result.ok).toBe(true)
    expect(mocks.start).toHaveBeenCalledWith('founder-auth-user-1', {
      capability: 'research.start',
      version: 1,
      workspaceId: null,
      args: { questionId: 'question-existing' },
    })
  })
})
