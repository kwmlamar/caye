import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const stubRows = vi.hoisted(() => ({ data: [] as Array<Record<string, unknown>>, error: null as { message: string } | null }))
const eqCalls = vi.hoisted(() => [] as Array<[string, unknown]>)

vi.mock('@/lib/supabase-server', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => {
        const builder = {
          eq: (col: string, val: unknown) => {
            eqCalls.push([col, val])
            return builder
          },
          order: () => Promise.resolve(stubRows),
        }
        return builder
      },
    }),
  }),
}))

const { summarizeInvestigation, buildContinuationPrompt, MAX_INVESTIGATION_CONTINUATIONS } = await import(
  './investigation'
)
const { createServiceClient } = await import('@/lib/supabase-server')

describe('summarizeInvestigation — deterministic digest of caye_tool_calls (2026-08-17 Bimini audit fix)', () => {
  it('returns an empty digest when nothing has been recorded for this investigation yet', async () => {
    stubRows.data = []
    stubRows.error = null
    const digest = await summarizeInvestigation(createServiceClient(), 'inv-fresh', 'ws-1')
    expect(digest.totalCalls).toBe(0)
    expect(digest.summaryText).toBe('')
    expect(digest.coveredSubjects).toEqual([])
  })

  it('returns an empty digest on a load error rather than throwing', async () => {
    stubRows.data = []
    stubRows.error = { message: 'connection reset' }
    const digest = await summarizeInvestigation(createServiceClient(), 'inv-err', 'ws-1')
    expect(digest.totalCalls).toBe(0)
    expect(digest.summaryText).toBe('')
  })

  it('scopes the query to both investigation_id AND workspace_id — defense in depth against cross-workspace leakage', async () => {
    eqCalls.length = 0
    stubRows.data = []
    stubRows.error = null
    await summarizeInvestigation(createServiceClient(), 'inv-scope', 'ws-scope')
    expect(eqCalls).toContainEqual(['investigation_id', 'inv-scope'])
    expect(eqCalls).toContainEqual(['workspace_id', 'ws-scope'])
  })

  it('groups by tool name and counts success/failure separately', async () => {
    stubRows.error = null
    stubRows.data = [
      { tool_name: 'get_revenue', status: 'SUCCESS', deferred: false, args: {}, created_at: '2026-08-17T13:13:50Z' },
      { tool_name: 'get_customer_history', status: 'SUCCESS', deferred: false, args: { conversation_id: 'conv-a' }, created_at: '2026-08-17T13:13:51Z' },
      { tool_name: 'get_customer_history', status: 'SUCCESS', deferred: false, args: { conversation_id: 'conv-b' }, created_at: '2026-08-17T13:13:52Z' },
      { tool_name: 'get_customer_history', status: 'NOT_FOUND', deferred: false, args: { conversation_id: 'conv-c' }, created_at: '2026-08-17T13:13:53Z' },
    ]

    const digest = await summarizeInvestigation(createServiceClient(), 'inv-1', 'ws-1')
    expect(digest.totalCalls).toBe(4)
    expect(digest.summaryText).toContain('get_revenue: 1 succeeded')
    expect(digest.summaryText).toContain('get_customer_history: 2 succeeded')
    expect(digest.summaryText).toContain('1 failed')
  })

  it('never blends a failed subject into the succeeded list — a model must be able to tell which is which', async () => {
    stubRows.error = null
    stubRows.data = [
      { tool_name: 'get_customer_history', status: 'SUCCESS', deferred: false, args: { conversation_id: 'conv-good' }, created_at: '2026-08-17T13:13:50Z' },
      { tool_name: 'get_customer_history', status: 'NOT_FOUND', deferred: false, args: { conversation_id: 'conv-bad' }, created_at: '2026-08-17T13:13:51Z' },
    ]
    const digest = await summarizeInvestigation(createServiceClient(), 'inv-mix', 'ws-1')
    // Regression: the old digest rendered a single "(e.g. conv-good, conv-bad)"
    // list with no way to tell which succeeded. Now they must be labeled
    // separately, and the failed one must never appear under "covered."
    const coveredSegment = digest.summaryText.match(/Already covered \(do not re-fetch\): ([^.]+)\./)![1]
    expect(coveredSegment).toContain('conv-good')
    expect(coveredSegment).not.toContain('conv-bad')
    expect(digest.summaryText).toContain('FAILED for: conv-bad')
    expect(digest.coveredSubjects).toEqual(['conv-good'])
    expect(digest.coveredSubjects).not.toContain('conv-bad')
  })

  it('does not truncate the covered-subjects list at an arbitrary small cap — every successful subject must be listed', async () => {
    stubRows.error = null
    stubRows.data = Array.from({ length: 23 }, (_, i) => ({
      tool_name: 'get_customer_history',
      status: 'SUCCESS',
      deferred: false,
      args: { conversation_id: `conv-${i}` },
      created_at: `2026-08-17T13:${String(13 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
    }))
    const digest = await summarizeInvestigation(createServiceClient(), 'inv-many', 'ws-1')
    for (let i = 0; i < 23; i++) {
      expect(digest.summaryText).toContain(`conv-${i}`)
      expect(digest.coveredSubjects).toContain(`conv-${i}`)
    }
  })

  it('dedupes a subject called more than once rather than listing it twice', async () => {
    stubRows.error = null
    stubRows.data = [
      { tool_name: 'get_customer_history', status: 'SUCCESS', deferred: false, args: { conversation_id: 'conv-dup' }, created_at: '2026-08-17T13:13:50Z' },
      { tool_name: 'get_customer_history', status: 'SUCCESS', deferred: false, args: { conversation_id: 'conv-dup' }, created_at: '2026-08-17T13:13:51Z' },
    ]
    const digest = await summarizeInvestigation(createServiceClient(), 'inv-dup', 'ws-1')
    expect(digest.coveredSubjects).toEqual(['conv-dup'])
  })

  it('reports a deferred (saved-locally, pending external sync) success separately from a fully confirmed one', async () => {
    stubRows.error = null
    stubRows.data = [
      { tool_name: 'add_internal_note', status: 'SUCCESS', deferred: true, args: {}, created_at: '2026-08-17T13:13:50Z' },
      { tool_name: 'add_internal_note', status: 'SUCCESS', deferred: false, args: {}, created_at: '2026-08-17T13:13:51Z' },
    ]
    const digest = await summarizeInvestigation(createServiceClient(), 'inv-deferred', 'ws-1')
    expect(digest.summaryText).toContain('1 succeeded')
    expect(digest.summaryText).toContain('1 saved locally, pending external sync')
  })

  it('never fabricates a subject when args carries nothing identifying', async () => {
    stubRows.error = null
    stubRows.data = [{ tool_name: 'get_held_queue', status: 'SUCCESS', deferred: false, args: {}, created_at: '2026-08-17T13:13:50Z' }]
    const digest = await summarizeInvestigation(createServiceClient(), 'inv-2', 'ws-1')
    expect(digest.summaryText).toBe('- get_held_queue: 1 succeeded')
  })

  it('never includes raw tool_result content, message bodies, emails, or phone numbers — only tool names, statuses, and short identifiers', async () => {
    stubRows.error = null
    stubRows.data = [
      {
        tool_name: 'get_customer_history',
        status: 'SUCCESS',
        deferred: false,
        // Realistic args shape: only an id, never PII directly, mirroring
        // every real tool in the registry (they take ids, not raw contact
        // info). The digest must not go digging for PII even if a future
        // tool's args carried more.
        args: { conversation_id: 'conv-xyz' },
        created_at: '2026-08-17T13:13:50Z',
      },
    ]
    const digest = await summarizeInvestigation(createServiceClient(), 'inv-pii', 'ws-1')
    expect(digest.summaryText).not.toMatch(/@/) // no email
    expect(digest.summaryText).not.toMatch(/\d{7,}/) // no phone-length digit run
  })
})

describe('buildContinuationPrompt', () => {
  const emptyDigest = { totalCalls: 0, summaryText: '', coveredSubjects: [] }

  it('repeats the original objective verbatim so a continuation cannot drift onto a different task', () => {
    const prompt = buildContinuationPrompt('Audit Bimini Island Tours revenue for the last 5 months.', emptyDigest)
    expect(prompt).toContain('Audit Bimini Island Tours revenue for the last 5 months.')
  })

  it('includes the prior findings digest when there is one', () => {
    const prompt = buildContinuationPrompt('Audit everything.', {
      totalCalls: 47,
      summaryText: '- get_customer_history: 22 succeeded',
      coveredSubjects: [],
    })
    expect(prompt).toContain('47')
    expect(prompt).toContain('get_customer_history: 22 succeeded')
  })

  it('explicitly instructs against asking the founder for permission to continue', () => {
    const prompt = buildContinuationPrompt('Audit everything.', emptyDigest)
    expect(prompt.toLowerCase()).toContain('do not ask whether to continue')
  })

  it('tells the model missing-looking data is recoverable by re-running the tool, not lost', () => {
    const prompt = buildContinuationPrompt('Audit everything.', {
      totalCalls: 3,
      summaryText: '- get_customer_history: 3 succeeded. Already covered (do not re-fetch): conv-a, conv-b, conv-c',
      coveredSubjects: ['conv-a', 'conv-b', 'conv-c'],
    })
    expect(prompt.toLowerCase()).toMatch(/call that same tool with the same arguments/)
  })

  it('instructs the model not to re-fetch what the digest already marks as covered', () => {
    const prompt = buildContinuationPrompt('Audit everything.', {
      totalCalls: 3,
      summaryText: '- get_customer_history: 3 succeeded. Already covered (do not re-fetch): conv-a, conv-b, conv-c',
      coveredSubjects: ['conv-a', 'conv-b', 'conv-c'],
    })
    expect(prompt.toLowerCase()).toContain('do not re-fetch anything listed above')
  })

  it('states plainly that only read tools are available this pass, framed as intentional not broken', () => {
    const prompt = buildContinuationPrompt('Audit everything.', emptyDigest)
    expect(prompt.toLowerCase()).toContain('only tools that read data are available')
  })
})

describe('MAX_INVESTIGATION_CONTINUATIONS', () => {
  it('is a small, finite bound — never unlimited', () => {
    expect(MAX_INVESTIGATION_CONTINUATIONS).toBeGreaterThan(0)
    expect(MAX_INVESTIGATION_CONTINUATIONS).toBeLessThanOrEqual(10)
  })
})
