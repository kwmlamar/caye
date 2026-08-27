import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tool, ToolContext, ToolResult } from './tools/types'

vi.mock('server-only', () => ({}))

// caye_tool_calls writes are fire-and-forget; swallow them.
const inserted: Record<string, unknown>[] = []
vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        inserted.push(row)
        return { data: null, error: null }
      },
    }),
  }),
}))

const { runToolWithRecovery, operationKey, guidanceFor } = await import('./orchestrator')

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceId: '00000000-0000-0000-0000-0000000000aa',
    callerRole: 'owner',
    operatorId: 7,
    requestId: 'req-1',
    ...overrides,
  }
}

function makeTool(
  risk: 'read' | 'low' | 'high',
  impl: (args: unknown, c: ToolContext) => Promise<ToolResult>
): Tool<never> {
  return {
    name: 'add_internal_note',
    description: 'test',
    inputSchema: { type: 'object', properties: {} },
    risk,
    roles: ['owner'],
    modes: ['back-office'],
    execute: impl as Tool<never>['execute'],
  } as Tool<never>
}

beforeEach(() => {
  inserted.length = 0
})

describe('runToolWithRecovery — retry budgets', () => {
  it('retries a transient read up to three attempts', async () => {
    let calls = 0
    const tool = makeTool('read', async () => {
      calls += 1
      if (calls < 3) throw new Error('fetch failed')
      return { ok: true, data: { calls } }
    })

    const { result, attempts } = await runToolWithRecovery(tool, {}, ctx(), { mode: 'back-office' })
    expect(attempts).toBe(3)
    expect(result.ok).toBe(true)
  })

  it('retries a low-risk write exactly once', async () => {
    // A FAILED_RETRYABLE write overwhelmingly means the database was
    // unreachable, so nothing committed — one retry is worth it. More than
    // one starts trading duplicate risk for diminishing returns.
    let calls = 0
    const tool = makeTool('low', async () => {
      calls += 1
      throw new Error('ETIMEDOUT')
    })

    const { attempts, result } = await runToolWithRecovery(tool, {}, ctx(), { mode: 'back-office' })
    expect(calls).toBe(2)
    expect(attempts).toBe(2)
    expect(result.status).toBe('FAILED_RETRYABLE')
  })

  it('never retries a high-risk write', async () => {
    // Cancelling a booking or charging a card twice is worse than reporting a
    // failure a human can simply repeat.
    let calls = 0
    const tool = makeTool('high', async () => {
      calls += 1
      throw new Error('fetch failed')
    })

    await runToolWithRecovery(tool, {}, ctx(), { mode: 'back-office' })
    expect(calls).toBe(1)
  })

  it('retries a draft only when the draft tool explicitly proves the failure is retryable', async () => {
    let calls = 0
    const tool = { ...makeTool('high', async () => {
      calls += 1
      return { ok: false, status: 'FAILED_RETRYABLE' as const, retryable: true, error: 'rate limited' }
    }), name: 'draft_in_inbox' }
    const { attempts } = await runToolWithRecovery(tool, {}, ctx(), { mode: 'back-office' })
    expect(calls).toBe(2)
    expect(attempts).toBe(2)
  })

  it('does not retry an ambiguously created draft', async () => {
    let calls = 0
    const tool = { ...makeTool('high', async () => {
      calls += 1
      return { ok: false, status: 'NEEDS_HUMAN' as const, error: 'creation uncertain' }
    }), name: 'draft_in_inbox' }
    const { attempts } = await runToolWithRecovery(tool, {}, ctx(), { mode: 'back-office' })
    expect(calls).toBe(1)
    expect(attempts).toBe(1)
  })

  it('does not retry a permanent failure even for a read', async () => {
    let calls = 0
    const tool = makeTool('read', async () => {
      calls += 1
      throw { code: '22P02', message: 'invalid input value for enum sender_type: "system"' }
    })

    const { result } = await runToolWithRecovery(tool, {}, ctx(), { mode: 'back-office' })
    expect(calls).toBe(1)
    expect(result.status).toBe('FAILED_PERMANENT')
  })
})

describe('runToolWithRecovery — containment', () => {
  it('never throws, whatever the tool does', async () => {
    // The caller is a live WhatsApp turn. An exception here is silence on a
    // paying customer's phone.
    const tool = makeTool('low', async () => {
      throw new Error('catastrophic')
    })
    await expect(runToolWithRecovery(tool, {}, ctx(), { mode: 'back-office' })).resolves.toBeDefined()
  })

  it('survives a tool that rejects with a non-Error', async () => {
    const tool = makeTool('low', async () => {
      throw 'a bare string'
    })
    const { result } = await runToolWithRecovery(tool, {}, ctx(), { mode: 'back-office' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('a bare string')
  })
})

describe('runToolWithRecovery — idempotency', () => {
  it('hands the tool a stable operation key it can pass downstream', async () => {
    let seen: string | undefined
    const tool = makeTool('low', async (_args, c) => {
      seen = c.operationKey
      return { ok: true }
    })
    await runToolWithRecovery(tool, { note: 'x' }, ctx(), { mode: 'back-office' })
    expect(seen).toBe(operationKey('req-1', 'add_internal_note', { note: 'x' }))
  })

  it('keeps the key identical across retries of one call', async () => {
    const keys: (string | undefined)[] = []
    const tool = makeTool('read', async (_args, c) => {
      keys.push(c.operationKey)
      throw new Error('fetch failed')
    })
    await runToolWithRecovery(tool, { a: 1 }, ctx(), { mode: 'back-office' })
    expect(new Set(keys).size).toBe(1)
  })

  it('is insensitive to argument key order but sensitive to values', () => {
    expect(operationKey('r', 't', { a: 1, b: 2 })).toBe(operationKey('r', 't', { b: 2, a: 1 }))
    expect(operationKey('r', 't', { a: 1 })).not.toBe(operationKey('r', 't', { a: 2 }))
  })

  it('separates turns, so a genuinely new request is a new operation', () => {
    // Two turns asking for the same thing are two intents. Collapsing them
    // would make "send it again" impossible.
    expect(operationKey('req-1', 't', { a: 1 })).not.toBe(operationKey('req-2', 't', { a: 1 }))
  })
})

describe('runToolWithRecovery — observability', () => {
  it('logs the outcome, attempt count and tool for every call', async () => {
    const tool = makeTool('low', async () => ({ ok: false, error: 'nope' }))
    await runToolWithRecovery(tool, {}, ctx(), { mode: 'back-office' })
    await new Promise((r) => setTimeout(r, 0)) // log write is fire-and-forget

    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      tool_name: 'add_internal_note',
      status: 'FAILED_PERMANENT',
      attempts: 1,
      request_id: 'req-1',
      caller_role: 'owner',
    })
  })
})

describe('runToolWithRecovery — investigation provenance (2026-08-17 Bimini audit fix)', () => {
  it('records investigationId, toolUseId, and args on the caye_tool_calls row', async () => {
    const tool = makeTool('read', async () => ({ ok: true, data: { found: true } }))
    await runToolWithRecovery(
      tool,
      { conversation_id: 'conv-123' },
      ctx({ investigationId: 'inv-abc' }),
      { mode: 'back-office', toolUseId: 'toolu_999' }
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      investigation_id: 'inv-abc',
      tool_use_id: 'toolu_999',
      args: { conversation_id: 'conv-123' },
    })
  })

  it('leaves investigation_id/tool_use_id null for an ordinary (non-investigation) call', async () => {
    const tool = makeTool('read', async () => ({ ok: true }))
    await runToolWithRecovery(tool, {}, ctx(), { mode: 'back-office' })
    await new Promise((r) => setTimeout(r, 0))

    expect(inserted[0]).toMatchObject({ investigation_id: null, tool_use_id: null })
  })
})

describe('guidanceFor', () => {
  it('forbids handing the work back to the operator on a failed write', () => {
    // The whole point. Left to itself the model told Mrs. Max to write her
    // own note down; this is the instruction that replaces that judgement.
    const g = guidanceFor('FAILED_PERMANENT', false)!
    expect(g).toMatch(/never ask the operator to do it themselves/i)
  })

  it('preserves a draft request rather than offering a send after a draft failure', () => {
    const g = guidanceFor('NEEDS_HUMAN', false, 'draft_in_inbox')!
    expect(g).toMatch(/do NOT offer to send/i)
    expect(g).toMatch(/do not retry blindly/i)
  })

  it('tells the model a deferred write is done', () => {
    const g = guidanceFor('SUCCESS', true)!
    expect(g).toMatch(/saved/i)
    expect(g).toMatch(/do not ask the operator to record anything/i)
  })

  it('says nothing on a plain success', () => {
    expect(guidanceFor('SUCCESS', false)).toBeNull()
  })

  it('steers a conflict toward confirming the existing record', () => {
    expect(guidanceFor('CONFLICT', false)).toMatch(/already exists/i)
  })
})

describe('guidanceFor — draft_in_inbox error_code-specific guidance (CAY-139, 2026-08-26 Bimini incident)', () => {
  // Before this, every draft_in_inbox failure got one generic "blocked or
  // uncertain" sentence, and the model filled the gap itself — live on
  // Bimini it invented "the staging system is down" / "backend issue" /
  // implied TropiTech should be notified, none of which any tool result
  // ever said. Every branch below must both give the true reason AND
  // explicitly INSTRUCT the model not to reach for that language (the
  // instruction necessarily names the banned phrases in order to forbid
  // them — these assertions check the prohibition is present, not that the
  // words are absent from the guidance text).
  const forbidsOutageLanguage = /never describe this as a system outage/i
  const forbidsFakeEscalation = /never say anyone was notified or flagged.*unless a tool result actually says so/i

  it('rate-limited: says nothing was created and a retry is safe, and forbids outage/escalation language', () => {
    const g = guidanceFor('FAILED_RETRYABLE', false, 'draft_in_inbox', 'ZOHO_DRAFT_RATE_LIMITED')!
    expect(g).toMatch(/nothing was created/i)
    expect(g).toMatch(/rate limited/i)
    expect(g).toMatch(forbidsOutageLanguage)
    expect(g).toMatch(forbidsFakeEscalation)
  })

  it('auth required: says the connection needs reconnecting, forbids outage/escalation language', () => {
    const g = guidanceFor('NEEDS_HUMAN', false, 'draft_in_inbox', 'ZOHO_DRAFT_AUTH_REQUIRED')!
    expect(g).toMatch(/reconnect/i)
    expect(g).toMatch(forbidsOutageLanguage)
    expect(g).toMatch(forbidsFakeEscalation)
  })

  it('verification-mode-not-live: says the workspace needs one-time verification, forbids outage language', () => {
    const g = guidanceFor('FAILED_PERMANENT', false, 'draft_in_inbox', 'ZOHO_DRAFT_MODE_NOT_VERIFIED')!
    expect(g).toMatch(/verif/i)
    expect(g).toMatch(forbidsOutageLanguage)
  })

  it('deterministic rejection: says nothing was created, no ambiguity language, forbids outage language', () => {
    const g = guidanceFor('FAILED_PERMANENT', false, 'draft_in_inbox', 'ZOHO_DRAFT_REJECTED')!
    expect(g).not.toMatch(/not sure whether/i)
    expect(g).toMatch(forbidsOutageLanguage)
  })

  it('creation uncertain: says the outcome is unknown and forbids claiming it failed or offering to send instead', () => {
    const g = guidanceFor('NEEDS_HUMAN', false, 'draft_in_inbox', 'ZOHO_DRAFT_CREATION_UNCERTAIN')!
    expect(g).toMatch(/not sure whether/i)
    expect(g).toMatch(/deliberately did not retry/i)
    expect(g).toMatch(/do NOT say it failed/i)
    expect(g).toMatch(/do NOT offer to send/i)
    expect(g).toMatch(forbidsOutageLanguage)
  })

  it('an unrecognised error_code on draft_in_inbox falls back to the original generic guidance (backward compatible)', () => {
    const g = guidanceFor('NEEDS_HUMAN', false, 'draft_in_inbox')!
    expect(g).toMatch(/do NOT offer to send/i)
    expect(g).toMatch(/do not retry blindly/i)
  })

  it('every draft_in_inbox failure branch explicitly forbids claiming an outage or an unsent escalation', () => {
    const codes = [
      ['FAILED_RETRYABLE', 'ZOHO_DRAFT_RATE_LIMITED'],
      ['NEEDS_HUMAN', 'ZOHO_DRAFT_AUTH_REQUIRED'],
      ['FAILED_PERMANENT', 'ZOHO_DRAFT_MODE_NOT_VERIFIED'],
      ['FAILED_PERMANENT', 'ZOHO_DRAFT_REJECTED'],
      ['NEEDS_HUMAN', 'ZOHO_DRAFT_CREATION_UNCERTAIN'],
    ] as const
    for (const [status, code] of codes) {
      const g = guidanceFor(status, false, 'draft_in_inbox', code)!
      expect(g).toMatch(forbidsOutageLanguage)
      expect(g).toMatch(forbidsFakeEscalation)
    }
  })
})
