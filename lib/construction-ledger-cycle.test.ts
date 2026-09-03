import { describe, expect, it } from 'vitest'

import { runConstructionLedgerCycle } from './construction-ledger-cycle'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const BRIDGE_OK = {
  scanned: 3, emitted: 2, duplicates: 1, stale: 0,
  suppressed: 0, unresolved: 0, batches: 1, cursor: 'c1',
}
/** Every stream reports its own outcome; one failing does not fail the pass. */
const SYNC_OK = [
  { stream: 'purchase_orders', ok: true, result: BRIDGE_OK },
  { stream: 'projects', ok: true, result: BRIDGE_OK },
  { stream: 'estimates', ok: false, error: 'estimates unreadable' },
]
const ATTENTION_OK = { considered: 2, raised: 2, skipped: { bootstrap: 0, unresolvable: 0 } }
const RECEIVABLES_OK = { considered: 1, raised: 1, skipped: { draft: 0, settled: 0 } }

function deps(over: Record<string, unknown> = {}) {
  const calls: string[] = []
  return {
    calls,
    deps: {
      listBoundWorkspaces: async () => [A],
      sync: (async () => { calls.push('sync'); return SYNC_OK }) as never,
      project: (async () => { calls.push('project'); return ATTENTION_OK }) as never,
      // A harmless fake, not tracked in `calls` — every existing test below
      // predates the receivables sweep and asserts exact call ordering for
      // sync/project only. Never the live default, which would reach a real
      // Supabase-backed adapter with no credentials in this environment.
      raiseReceivables: (async () => RECEIVABLES_OK) as never,
      ...over,
    },
  }
}

describe('runConstructionLedgerCycle', () => {
  it('polls the source before raising attention', async () => {
    // Attention can only surface what the sync ingested.
    const { calls, deps: d } = deps()
    await runConstructionLedgerCycle({ deps: d })

    expect(calls).toEqual(['sync', 'project'])
  })

  it('still delivers attention when the source poll fails', async () => {
    // A source outage must not also withhold changes ingested on an earlier
    // pass that have not yet reached anyone.
    const { calls, deps: d } = deps({
      sync: (async () => { throw new Error('bedrock unreachable') }) as never,
    })
    const result = await runConstructionLedgerCycle({ deps: d })

    expect(calls).toEqual(['project'])
    expect(result.results[0].syncError).toBe('bedrock unreachable')
    expect(result.results[0].attention).toEqual(ATTENTION_OK)
  })

  it('does not let one workspace failure stop the workspaces after it', async () => {
    const seen: string[] = []
    const result = await runConstructionLedgerCycle({
      deps: {
        listBoundWorkspaces: async () => [A, B],
        sync: (async ({ workspaceId }: { workspaceId: string }) => {
          seen.push(workspaceId)
          if (workspaceId === A) throw new Error('boom')
          return SYNC_OK
        }) as never,
        project: (async () => ATTENTION_OK) as never,
      },
    })

    expect(seen).toEqual([A, B])
    expect(result.workspaces).toBe(2)
    expect(result.results[0].syncError).toBe('boom')
    expect(result.results[1].sync).toEqual(SYNC_OK)
  })

  it('records an attention failure without discarding a successful sync', async () => {
    const { deps: d } = deps({
      project: (async () => { throw new Error('attention ledger down') }) as never,
    })
    const result = await runConstructionLedgerCycle({ deps: d })

    expect(result.results[0].sync).toEqual(SYNC_OK)
    expect(result.results[0].attentionError).toBe('attention ledger down')
  })

  it('asks for an overlapping attention window rather than a tight cursor', async () => {
    // Both halves are idempotent, so overlap is cheap and a gap is not.
    let since: Date | undefined
    await runConstructionLedgerCycle({
      attentionWindowMs: 60_000,
      deps: {
        listBoundWorkspaces: async () => [A],
        sync: (async () => SYNC_OK) as never,
        project: (async (args: { since?: Date }) => { since = args.since; return ATTENTION_OK }) as never,
      },
    })

    expect(since).toBeInstanceOf(Date)
    const ageMs = Date.now() - (since as Date).getTime()
    expect(ageMs).toBeGreaterThanOrEqual(59_000)
    expect(ageMs).toBeLessThan(65_000)
  })

  it('does nothing when no workspace is bound to a ledger', async () => {
    const { calls, deps: d } = deps({ listBoundWorkspaces: async () => [] })
    const result = await runConstructionLedgerCycle({ deps: d })

    expect(result).toEqual({ workspaces: 0, results: [] })
    expect(calls).toEqual([])
  })

  it('sweeps receivables alongside the domain-event projection', async () => {
    const { calls, deps: d } = deps({
      raiseReceivables: (async ({ workspaceId }: { workspaceId: string }) => {
        calls.push(`receivables:${workspaceId}`)
        return RECEIVABLES_OK
      }) as never,
    })
    const result = await runConstructionLedgerCycle({ deps: d })

    expect(calls).toEqual(['sync', 'project', `receivables:${A}`])
    expect(result.results[0].receivables).toEqual(RECEIVABLES_OK)
    expect(result.results[0].receivablesError).toBeNull()
  })

  it('a receivables sweep failure does not discard a successful sync or attention pass', async () => {
    const { deps: d } = deps({
      raiseReceivables: (async () => { throw new Error('bedrock unreachable for receivables') }) as never,
    })
    const result = await runConstructionLedgerCycle({ deps: d })

    expect(result.results[0].sync).toEqual(SYNC_OK)
    expect(result.results[0].attention).toEqual(ATTENTION_OK)
    expect(result.results[0].receivablesError).toBe('bedrock unreachable for receivables')
    expect(result.results[0].receivables).toBeNull()
  })

  it('a receivables failure in one workspace does not stop the sweep for the next', async () => {
    const seen: string[] = []
    const result = await runConstructionLedgerCycle({
      deps: {
        listBoundWorkspaces: async () => [A, B],
        sync: (async () => SYNC_OK) as never,
        project: (async () => ATTENTION_OK) as never,
        raiseReceivables: (async ({ workspaceId }: { workspaceId: string }) => {
          seen.push(workspaceId)
          if (workspaceId === A) throw new Error('boom')
          return RECEIVABLES_OK
        }) as never,
      },
    })

    expect(seen).toEqual([A, B])
    expect(result.results[0].receivablesError).toBe('boom')
    expect(result.results[1].receivables).toEqual(RECEIVABLES_OK)
  })

  it('does not gate the receivables sweep on an attention window, unlike the domain-event projection', async () => {
    // The receivables sweep re-reads current invoice state every pass and
    // relies only on the ledger's fingerprint, not a time window.
    let sawWindowArg = true
    const { deps: d } = deps({
      raiseReceivables: (async (args: Record<string, unknown>) => {
        sawWindowArg = 'since' in args
        return RECEIVABLES_OK
      }) as never,
    })
    await runConstructionLedgerCycle({ deps: d, attentionWindowMs: 60_000 })

    expect(sawWindowArg).toBe(false)
  })
})
