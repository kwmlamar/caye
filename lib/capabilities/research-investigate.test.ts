import { beforeEach, describe, expect, it, vi } from 'vitest'

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

function dbFor(options?: { existingQuestion?: boolean; inbound?: boolean }) {
  const tables: string[] = []
  const inserts: Array<{ table: string; value: any }> = []
  const existingQuestion = options?.existingQuestion ?? false
  const inbound = options?.inbound ?? true

  function chain(terminal: () => any) {
    const q: any = {}
    for (const method of ['select','eq','neq','in','order','limit']) q[method] = vi.fn(() => q)
    q.maybeSingle = vi.fn(async () => terminal())
    q.single = vi.fn(async () => terminal())
    return q
  }

  const db = {
    from(table: string) {
      tables.push(table)
      if (table === 'caye_operator_messages') {
        return chain(() => inbound
          ? { data: { id: 'message-1', workspace_id: 'workspace-1', body: 'NVIDIA bought Hugging Face. Look into that.', direction: 'inbound', origin: 'dashboard', operator_role: 'founder' }, error: null }
          : { data: null, error: null })
      }
      if (table === 'research_programs') {
        return chain(() => ({ data: { id: 'program-ai', title: 'AI & Global Technology Intelligence' }, error: null }))
      }
      if (table === 'research_questions') {
        const lookup = chain(() => existingQuestion
          ? { data: { id: 'question-1', program_id: 'program-ai', question: 'Did NVIDIA acquire Hugging Face, and if so what exactly occurred?', status: 'open', canonical_key: 'nvidia:hugging-face:acquisition' }, error: null }
          : { data: null, error: null })
        lookup.insert = vi.fn((value: any) => {
          inserts.push({ table, value })
          return chain(() => ({ data: { id: 'question-1', program_id: 'program-ai', question: value.question, status: 'open', canonical_key: value.canonical_key }, error: null }))
        })
        return lookup
      }
      if (table === 'research_question_origins') {
        return {
          insert: vi.fn(async (value: any) => {
            inserts.push({ table, value })
            return { error: null }
          }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  }

  return { db, tables, inserts }
}

describe('research.investigate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.queueResearchRun.mockResolvedValue({ id: 'run-1', status: 'queued', question_id: 'question-1' })
  })

  it('normalizes semantic keys independently of punctuation/case', () => {
    expect(normalizeResearchCanonicalKey(' NVIDIA / Hugging-Face / Acquisition ')).toBe('nvidia:hugging:face:acquisition')
  })

  it('stores the founder assertion only as an unverified origin and queues the existing runtime', async () => {
    const fake = dbFor()
    mocks.createServiceClient.mockReturnValue(fake.db)

    const result = await researchInvestigateCapability.execute(args, founder)

    expect(result.status).toBe('staged')
    expect((result.data as any).epistemicStatus).toBe('unverified_lead')
    expect(mocks.queueResearchRun).toHaveBeenCalledWith('question-1', 'founder_direct')
    expect(fake.tables).not.toContain('research_claims')
    expect(fake.inserts.find((x) => x.table === 'research_question_origins')?.value).toMatchObject({
      founder_user_id: 'founder-auth-1',
      source_workspace_id: 'workspace-1',
      direct_thread_id: 'thread-1',
      inbound_message_id: 'message-1',
      original_wording: 'NVIDIA bought Hugging Face. Look into that.',
      lead_text: 'NVIDIA bought Hugging Face',
    })
  })

  it('reuses an equivalent current question instead of inserting a duplicate', async () => {
    const fake = dbFor({ existingQuestion: true })
    mocks.createServiceClient.mockReturnValue(fake.db)

    const result = await researchInvestigateCapability.execute({
      ...args,
      lead: 'I heard Hugging Face was acquired by NVIDIA',
      verificationQuestion: 'Was Hugging Face acquired by NVIDIA, and what actually happened?',
      canonicalKey: 'nvidia:hugging:face:acquisition',
    }, founder)

    expect(result.status).toBe('staged')
    expect((result.data as any).reused).toBe(true)
    expect(fake.inserts.filter((x) => x.table === 'research_questions')).toHaveLength(0)
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
    const fake = dbFor({ inbound: false })
    mocks.createServiceClient.mockReturnValue(fake.db)

    const result = await researchInvestigateCapability.execute(args, founder)
    expect(result.status).toBe('failed')
    expect(result.failure?.code).toBe('not_authorized')
    expect(fake.inserts).toHaveLength(0)
    expect(mocks.queueResearchRun).not.toHaveBeenCalled()
  })
})
