import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { createDryRunCollector, wrapToolsForDryRun } from './dry-run'
import type { Tool, ToolContext } from './types'

const ctx: ToolContext = { workspaceId: 'ws_1', callerRole: 'owner', requestId: 'req_1' }

function makeTool(name: string, risk: Tool<{ x: number }>['risk'], executed: { count: number }): Tool<{ x: number }> {
  return {
    name,
    description: 'test tool',
    risk,
    roles: ['owner'],
    modes: ['back-office'],
    inputSchema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
    async execute(args) {
      executed.count += 1
      return { ok: true, data: { real: true, x: args.x } }
    },
  }
}

describe('wrapToolsForDryRun', () => {
  it('lets a read tool execute for real', async () => {
    const executed = { count: 0 }
    const tool = makeTool('get_thing', 'read', executed)
    const collector = createDryRunCollector()
    const [wrapped] = wrapToolsForDryRun([tool], collector)

    const result = await wrapped.execute({ x: 1 }, ctx)

    expect(executed.count).toBe(1)
    expect(result).toEqual({ ok: true, data: { real: true, x: 1 } })
    expect(collector.proposedActions).toHaveLength(0)
  })

  it('intercepts a low-risk tool and never calls its real execute', async () => {
    const executed = { count: 0 }
    const tool = makeTool('mark_handled', 'low', executed)
    const collector = createDryRunCollector()
    const [wrapped] = wrapToolsForDryRun([tool], collector)

    const result = await wrapped.execute({ x: 2 }, ctx)

    expect(executed.count).toBe(0)
    expect(result.ok).toBe(true)
    expect((result.data as { dry_run: boolean }).dry_run).toBe(true)
    expect(collector.proposedActions).toEqual([
      expect.objectContaining({ toolName: 'mark_handled', risk: 'low', args: { x: 2 } }),
    ])
  })

  it('intercepts a high-risk tool and never sends/mutates anything', async () => {
    const executed = { count: 0 }
    const tool = makeTool('send_reply', 'high', executed)
    const collector = createDryRunCollector()
    const [wrapped] = wrapToolsForDryRun([tool], collector)

    const result = await wrapped.execute({ x: 3 }, ctx)

    expect(executed.count).toBe(0)
    expect((result.data as { proposed: boolean }).proposed).toBe(true)
    expect(collector.proposedActions).toEqual([
      expect.objectContaining({ toolName: 'send_reply', risk: 'high' }),
    ])
  })

  it('records multiple proposed actions across multiple wrapped tools in call order', async () => {
    const executed = { count: 0 }
    const low = makeTool('mute_caye', 'low', executed)
    const high = makeTool('cancel_booking', 'high', executed)
    const collector = createDryRunCollector()
    const [wrappedLow, wrappedHigh] = wrapToolsForDryRun([low, high], collector)

    await wrappedLow.execute({ x: 1 }, ctx)
    await wrappedHigh.execute({ x: 2 }, ctx)

    expect(collector.proposedActions.map((a) => a.toolName)).toEqual(['mute_caye', 'cancel_booking'])
    expect(executed.count).toBe(0)
  })

  it('surfaces args.body as data.delivered_text for a terminatesTurn tool (Phase 3B)', async () => {
    const executed = { count: 0 }
    const tool: Tool<{ body: string }> = {
      name: 'send_customer_reply',
      description: 'test',
      risk: 'high',
      roles: ['owner'],
      modes: ['front-desk'],
      terminatesTurn: true,
      inputSchema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
      async execute() {
        executed.count += 1
        return { ok: true, data: { sent: true } }
      },
    }
    const collector = createDryRunCollector()
    const [wrapped] = wrapToolsForDryRun([tool], collector)

    const result = await wrapped.execute({ body: 'Here is your confirmation.' }, ctx)

    expect(executed.count).toBe(0)
    expect((result.data as { delivered_text?: string }).delivered_text).toBe('Here is your confirmation.')
  })

  it('does not add delivered_text for a non-terminatesTurn tool even if args has a body field', async () => {
    const executed = { count: 0 }
    const tool: Tool<{ body: string }> = {
      name: 'some_other_write_tool',
      description: 'test',
      risk: 'high',
      roles: ['owner'],
      modes: ['front-desk'],
      inputSchema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
      async execute() {
        executed.count += 1
        return { ok: true, data: {} }
      },
    }
    const collector = createDryRunCollector()
    const [wrapped] = wrapToolsForDryRun([tool], collector)

    const result = await wrapped.execute({ body: 'irrelevant' }, ctx)

    expect((result.data as { delivered_text?: string }).delivered_text).toBeUndefined()
  })
})
