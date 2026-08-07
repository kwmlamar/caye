import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({}) }))

import { isAgentAuthored, resolveTurnOwner } from './turn-ownership'

/**
 * Minimal stub of the caye_pending_actions query chain used by
 * resolveTurnOwner. Every filter returns `this`; the terminal maybeSingle
 * resolves to whatever the test supplies.
 */
function supabaseStub(result: { data: unknown; error: { message: string } | null }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'gt', 'order', 'limit']) {
    chain[m] = () => chain
  }
  chain.maybeSingle = async () => result
  return { from: () => chain } as never
}

const NO_PENDING = supabaseStub({ data: null, error: null })

// What each writer actually persists to claude_format — see the table in
// turn-ownership.ts. These are the real shapes, not invented ones.
const QUEUE_PING = null
const LEGACY_ACK = { role: 'assistant', content: 'Done. Sent to Kim.' }
const AGENT_TURN = {
  role: 'assistant',
  content: [{ type: 'text', text: "Here's what'll go out: … Send that?" }],
}

describe('isAgentAuthored', () => {
  it('distinguishes the three writers', () => {
    expect(isAgentAuthored(QUEUE_PING)).toBe(false)
    expect(isAgentAuthored(LEGACY_ACK)).toBe(false)
    expect(isAgentAuthored(AGENT_TURN)).toBe(true)
  })

  it('is not fooled by junk', () => {
    expect(isAgentAuthored(undefined)).toBe(false)
    expect(isAgentAuthored('a string')).toBe(false)
    expect(isAgentAuthored({})).toBe(false)
  })
})

describe('resolveTurnOwner', () => {
  it('gives the turn to the agent when an action is staged', async () => {
    // The 2026-08-07 failure: "Yes" confirming a staged send_reply to Zanzibar
    // was classified kind='send' and routed to the legacy path, which had
    // never heard of it. Ownership must ignore the classifier's label here —
    // note the last outbound below is NOT even agent-authored.
    const owner = await resolveTurnOwner({
      supabase: supabaseStub({ data: { tool_name: 'send_reply' }, error: null }),
      workspaceId: 'ws-1',
      operatorId: 7,
      lastOutboundClaudeFormat: QUEUE_PING,
    })
    expect(owner.owner).toBe('agent')
    expect(owner.reason).toMatch(/send_reply/)
  })

  it('gives the turn to the agent when the agent spoke last', async () => {
    // "Yea send that" — the agent had drafted in prose and asked, with nothing
    // staged yet. The referent (Zanzibar) lived in the agent's history, which
    // the classifier never sees.
    const owner = await resolveTurnOwner({
      supabase: NO_PENDING,
      workspaceId: 'ws-1',
      operatorId: 7,
      lastOutboundClaudeFormat: AGENT_TURN,
    })
    expect(owner.owner).toBe('agent')
  })

  it('leaves held-queue ping replies on the legacy path', async () => {
    for (const last of [QUEUE_PING, LEGACY_ACK]) {
      const owner = await resolveTurnOwner({
        supabase: NO_PENDING,
        workspaceId: 'ws-1',
        operatorId: 7,
        lastOutboundClaudeFormat: last,
      })
      expect(owner.owner).toBe('legacy')
    }
  })

  it('falls back to legacy when the staged lookup errors', async () => {
    // A lookup failure must not silently re-route every message.
    const owner = await resolveTurnOwner({
      supabase: supabaseStub({ data: null, error: { message: 'boom' } }),
      workspaceId: 'ws-1',
      operatorId: 7,
      lastOutboundClaudeFormat: QUEUE_PING,
    })
    expect(owner.owner).toBe('legacy')
  })
})
