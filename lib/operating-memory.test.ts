import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

let rpcArgs: Record<string, unknown> | null = null
let rpcData: unknown[] = []
let rpcError: { message: string } | null = null

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      rpcArgs = args
      return { data: rpcData, error: rpcError }
    },
  }),
}))

const { loadOperatingMemory, renderOperatingMemory } = await import('./operating-memory')

beforeEach(() => {
  rpcArgs = null
  rpcData = []
  rpcError = null
})

describe('operating memory boundaries', () => {
  it('always scopes retrieval to the caller workspace and does not opt into restricted memory by default', async () => {
    await loadOperatingMemory({ workspaceId: 'ws-a', query: 'pickup' })
    expect(rpcArgs).toMatchObject({
      p_workspace_id: 'ws-a',
      p_query: 'pickup',
      p_include_restricted: false,
    })
  })

  it('fails closed to no memory when retrieval errors instead of broad-reading another table', async () => {
    rpcError = { message: 'rpc unavailable' }
    expect(await loadOperatingMemory({ workspaceId: 'ws-a' })).toEqual([])
  })

  it('labels inferred knowledge as weaker context so one model judgment cannot propagate as policy', () => {
    const block = renderOperatingMemory([{ id: 'm1', memory_type: 'operating_pattern', subject_type: 'workspace', subject_id: null, category: 'logistics', fact: 'Guests often arrive 10 minutes late.', canonical_key: 'arrival-pattern', confidence: 0.61, knowledge_mode: 'inferred', authority_kind: 'inference', source: 'outcome-analysis', provenance: {}, valid_from: '2026-08-30T00:00:00Z', valid_until: null, created_at: '2026-08-30T00:00:00Z', relevance: 1 }])
    expect(block).toContain('not permission to create or change policy')
    expect(block).toContain('inferred, confidence 0.61')
  })

  it('drops malformed confidence values rather than feeding poisoned memory into the model', () => {
    const block = renderOperatingMemory([{ id: 'm1', memory_type: 'fact', subject_type: 'workspace', subject_id: null, category: 'policy', fact: 'Bad row', canonical_key: null, confidence: 4, knowledge_mode: 'explicit', authority_kind: 'owner', source: 'test', provenance: {}, valid_from: '2026-08-30T00:00:00Z', valid_until: null, created_at: '2026-08-30T00:00:00Z', relevance: 1 }])
    expect(block).toBeNull()
  })
})
