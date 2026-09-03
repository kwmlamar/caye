import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabaseClient, type FakeSupabaseClient } from '@/lib/supabase-test-support/fake-supabase-client'

const mocks = vi.hoisted(() => ({
  createServiceClient: vi.fn(),
  queueResearchRun: vi.fn(),
}))

vi.mock('@/lib/supabase-server', () => ({ createServiceClient: mocks.createServiceClient }))
vi.mock('@/lib/research/runtime', () => ({ queueResearchRun: mocks.queueResearchRun }))
vi.mock('server-only', () => ({}))

import { normalizeResearchCanonicalKey, researchInvestigateCapability } from './research-investigate'

const founder = {
  actor: { kind: 'founder' as const, userId: 'founder-auth-1' },
  scope: { workspaceId: null },
  caller: 'caye_direct' as const,
}

const args = {
  lead: 'NVIDIA bought Hugging Face',
  verificationQuestion: 'Did NVIDIA acquire Hugging Face, and if so what exactly occurred?',
  canonicalKey: 'NVIDIA / Hugging-Face / Acquisition',
  program: 'ai_global_technology' as const,
  origin: { workspaceId: 'workspace-1', threadId: 'thread-1', messageId: 'message-1' },
}

const NORMALIZED_KEY = 'nvidia:hugging:face:acquisition'

/**
 * Seeds the tables researchInvestigateCapability.execute() actually touches.
 * `existingQuestion` mirrors an already-current canonical question for the
 * key under test; `inbound` controls whether the trusted founder Direct
 * inbound message can be verified.
 */
function seedDb(options?: { existingQuestion?: boolean; inbound?: boolean }): FakeSupabaseClient {
  const existingQuestion = options?.existingQuestion ?? false
  const inbound = options?.inbound ?? true

  const client = createFakeSupabaseClient()

  client.seed('caye_operator_messages', inbound
    ? [{
        id: 'message-1',
        workspace_id: 'workspace-1',
        body: 'NVIDIA bought Hugging Face. Look into that.',
        direction: 'inbound',
        origin: 'dashboard',
        operator_role: 'founder',
      }]
    : [])

  client.seed('research_programs', [
    { id: 'program-ai', title: 'AI & Global Technology Intelligence', scope: 'operator', status: 'active' },
  ])

  client.seed(
    'research_questions',
    existingQuestion
      ? [{
          id: 'question-1',
          program_id: 'program-ai',
          question: 'Did NVIDIA acquire Hugging Face, and if so what exactly occurred?',
          status: 'open',
          canonical_key: NORMALIZED_KEY,
          investigation_mode: 'follow_until_resolved',
          lifecycle_status: 'active',
          refresh_interval_hours: 6,
        }]
      : [],
    { idGenerator: () => 'question-1' },
  )

  client.seed('research_question_origins', [])

  return client
}

describe('research.investigate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.queueResearchRun.mockResolvedValue({ id: 'run-1', status: 'queued', question_id: 'question-1' })
  })

  it('normalizes semantic keys independently of punctuation/case', () => {
    expect(normalizeResearchCanonicalKey(' NVIDIA / Hugging-Face / Acquisition ')).toBe(NORMALIZED_KEY)
  })

  it('stores the founder assertion only as an unverified origin and queues the existing runtime', async () => {
    const client = seedDb()
    mocks.createServiceClient.mockReturnValue(client)

    const result = await researchInvestigateCapability.execute(args, founder)

    expect(result.status).toBe('staged')
    expect((result.data as any).epistemicStatus).toBe('unverified_lead')
    expect(mocks.queueResearchRun).toHaveBeenCalledWith('question-1', 'founder_direct')
    // research.investigate never touches research_claims — the fake would
    // have thrown "unknown table" (failing the status assertion above) had
    // production code tried to query an unseeded table.
    expect(client.rows('research_question_origins')).toHaveLength(1)
    expect(client.rows('research_question_origins')[0]).toMatchObject({
      founder_user_id: 'founder-auth-1',
      source_workspace_id: 'workspace-1',
      direct_thread_id: 'thread-1',
      inbound_message_id: 'message-1',
      original_wording: 'NVIDIA bought Hugging Face. Look into that.',
      lead_text: 'NVIDIA bought Hugging Face',
    })
  })

  it('reuses an equivalent current question instead of inserting a duplicate', async () => {
    const client = seedDb({ existingQuestion: true })
    mocks.createServiceClient.mockReturnValue(client)

    const result = await researchInvestigateCapability.execute({
      ...args,
      lead: 'I heard Hugging Face was acquired by NVIDIA',
      verificationQuestion: 'Was Hugging Face acquired by NVIDIA, and what actually happened?',
      canonicalKey: NORMALIZED_KEY,
    }, founder)

    expect(result.status).toBe('staged')
    expect((result.data as any).reused).toBe(true)
    expect(client.rows('research_questions')).toHaveLength(1)
    expect(mocks.queueResearchRun).toHaveBeenCalledWith('question-1', 'founder_direct')
  })

  it('refuses non-founder authority before any database mutation', async () => {
    const result = await researchInvestigateCapability.execute(args, {
      ...founder,
      actor: { kind: 'staff', userId: 'staff-1' } as any,
    })
    expect(result.status).toBe('failed')
    expect(result.failure?.code).toBe('not_authorized')
    expect(mocks.createServiceClient).not.toHaveBeenCalled()
  })

  it('refuses customer-workspace capability scope', async () => {
    const result = await researchInvestigateCapability.execute(args, {
      ...founder,
      scope: { workspaceId: 'customer-workspace' },
    })
    expect(result.status).toBe('failed')
    expect(result.failure?.code).toBe('invalid_scope')
    expect(mocks.createServiceClient).not.toHaveBeenCalled()
  })

  it('fails closed when the durable inbound message cannot be verified in the source workspace', async () => {
    const client = seedDb({ inbound: false })
    mocks.createServiceClient.mockReturnValue(client)

    const result = await researchInvestigateCapability.execute(args, founder)
    expect(result.status).toBe('failed')
    expect(result.failure?.code).toBe('not_authorized')
    expect(client.rows('research_questions')).toHaveLength(0)
    expect(client.rows('research_question_origins')).toHaveLength(0)
    expect(mocks.queueResearchRun).not.toHaveBeenCalled()
  })
})
