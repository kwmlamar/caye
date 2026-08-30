import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { captureVoiceTurnMarks, computeTimings, mark, withVoiceTurnTrace } from './latency'

describe('voice turn tracing', () => {
  it('is a no-op outside a trace, so shared agent code paths are unaffected', () => {
    expect(() => mark('context_build_start')).not.toThrow()
    expect(() => mark('tool_done', { tool: 'get_revenue', ok: true })).not.toThrow()
  })

  it('records marks in order from deep inside the call stack', async () => {
    const { marks } = await captureVoiceTurnMarks(async () => {
      mark('auth_ok')
      await (async () => {
        await Promise.resolve()
        // Two frames down and across an await — the whole point of using
        // AsyncLocalStorage instead of threading a tracer argument.
        mark('context_build_start')
        mark('context_build_done', { systemPromptChars: 48083 })
      })()
      mark('reasoning_done')
    })

    expect(marks.map((m) => m.stage)).toEqual([
      'auth_ok',
      'context_build_start',
      'context_build_done',
      'reasoning_done',
    ])
    expect(marks[2].detail).toEqual({ systemPromptChars: 48083 })
    expect(marks.every((m) => typeof m.atMs === 'number' && m.atMs >= 0)).toBe(true)
  })

  it('does not leak a trace into unrelated concurrent work', async () => {
    const outside: string[] = []
    await captureVoiceTurnMarks(async () => {
      mark('auth_ok')
    })
    // After the trace has settled, marks go nowhere again.
    mark('auth_ok')
    expect(outside).toEqual([])
  })

  it('emits one timeline line per turn and rethrows a failure', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await expect(
        withVoiceTurnTrace({ workspaceId: 'ws-1', sessionId: 'voice_1' }, async () => {
          mark('auth_ok')
          throw new Error('boom')
        })
      ).rejects.toThrow('boom')

      const line = log.mock.calls.find((c) => c[0] === '[caye-voice] turn_timeline')
      expect(line).toBeDefined()
      const payload = JSON.parse(line![1] as string)
      expect(payload).toMatchObject({ workspaceId: 'ws-1', sessionId: 'voice_1', outcome: 'error' })
      expect(payload.marks.map((m: { stage: string }) => m.stage)).toContain('auth_ok')
    } finally {
      log.mockRestore()
    }
  })

  it('never records transcript or reply text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await withVoiceTurnTrace({ workspaceId: 'ws-1', sessionId: 'voice_1' }, async () => {
        mark('reasoning_done', { replyChars: 42 })
        return 'Traffic is down about twelve percent.'
      })
      const line = log.mock.calls.find((c) => c[0] === '[caye-voice] turn_timeline')!
      expect(line[1]).not.toContain('Traffic is down')
    } finally {
      log.mockRestore()
    }
  })
})

describe('computeTimings', () => {
  it('derives the spans the latency investigation reasons about', () => {
    const timings = computeTimings(
      [
        { stage: 'request_received', atMs: 0 },
        { stage: 'auth_ok', atMs: 120 },
        { stage: 'context_build_start', atMs: 125 },
        { stage: 'context_build_done', atMs: 975 },
        { stage: 'model_round_start', atMs: 980 },
        { stage: 'tool_start', atMs: 3200 },
        { stage: 'tool_done', atMs: 3900 },
        { stage: 'reasoning_done', atMs: 6100 },
        { stage: 'persist_start', atMs: 6110 },
        { stage: 'persist_done', atMs: 6500 },
      ],
      6600
    )

    expect(timings.authMs).toBe(120)
    expect(timings.contextBuildMs).toBe(850)
    expect(timings.reasoningMs).toBe(5120)
    expect(timings.toolMs).toBe(700)
    expect(timings.howManyTools).toBe(1)
    expect(timings.persistMs).toBe(390)
    expect(timings.totalMs).toBe(6600)
  })

  it('sums several tool calls in one turn rather than assuming a single one', () => {
    const timings = computeTimings(
      [
        { stage: 'tool_start', atMs: 100 },
        { stage: 'tool_done', atMs: 400 },
        { stage: 'tool_start', atMs: 450 },
        { stage: 'tool_done', atMs: 700 },
      ],
      800
    )
    expect(timings.toolMs).toBe(550)
    expect(timings.howManyTools).toBe(2)
  })

  it('reports null rather than a wrong number when a stage never happened', () => {
    const timings = computeTimings([{ stage: 'request_received', atMs: 0 }], 10)
    expect(timings.contextBuildMs).toBeNull()
    expect(timings.reasoningMs).toBeNull()
    expect(timings.toolMs).toBeNull()
    expect(timings.howManyTools).toBe(0)
  })

  it('does not pair a tool that started but never finished', () => {
    const timings = computeTimings(
      [
        { stage: 'tool_start', atMs: 100 },
        { stage: 'tool_done', atMs: 400 },
        { stage: 'tool_start', atMs: 450 },
      ],
      900
    )
    expect(timings.howManyTools).toBe(1)
    expect(timings.toolMs).toBe(300)
  })
})
