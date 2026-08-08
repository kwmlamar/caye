import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withSlowTurnHeartbeat, SLOW_TURN_MS } from './slow-turn-heartbeat'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** A promise resolved by hand, so a test controls exactly when work finishes. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('withSlowTurnHeartbeat', () => {
  it('stays silent on a fast turn', async () => {
    // The measured case: narration and answer completed 54ms apart. A
    // heartbeat here would be a second notification in the same instant.
    const onSlow = vi.fn(async () => {})
    const result = await withSlowTurnHeartbeat(async () => 'done', { onSlow })

    await vi.advanceTimersByTimeAsync(SLOW_TURN_MS * 2)
    expect(result).toBe('done')
    expect(onSlow).not.toHaveBeenCalled()
  })

  it('fires once when the turn outlives the threshold', async () => {
    // The real tail: bulk lead drafting and send_outreach_batch run 18-63s.
    const onSlow = vi.fn(async () => {})
    const work = deferred<string>()
    const promise = withSlowTurnHeartbeat(() => work.promise, { onSlow })

    await vi.advanceTimersByTimeAsync(SLOW_TURN_MS - 1)
    expect(onSlow).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2)
    expect(onSlow).toHaveBeenCalledTimes(1)

    work.resolve('answer')
    expect(await promise).toBe('answer')

    // Never a second buzz, however long the turn runs.
    await vi.advanceTimersByTimeAsync(SLOW_TURN_MS * 3)
    expect(onSlow).toHaveBeenCalledTimes(1)
  })

  it('lets the sender see the work finish underneath it', async () => {
    // The timer fires while work is in flight, but the Meta send itself takes
    // time. A heartbeat landing AFTER the answer reads worse than none, so the
    // caller re-checks stillRunning() immediately before dispatching — and it
    // must flip to false the moment the answer is ready.
    let stillRunning: (() => boolean) | null = null
    const work = deferred<string>()
    const promise = withSlowTurnHeartbeat(() => work.promise, {
      onSlow: async (probe) => {
        stillRunning = probe
      },
    })

    await vi.advanceTimersByTimeAsync(SLOW_TURN_MS + 1)
    expect(stillRunning).not.toBeNull()
    expect(stillRunning!()).toBe(true) // answer not ready — sending is correct

    work.resolve('answer')
    await promise

    expect(stillRunning!()).toBe(false) // answer landed — suppress the heartbeat
  })

  it('never lets a failed heartbeat fail the turn', async () => {
    const work = deferred<string>()
    const promise = withSlowTurnHeartbeat(() => work.promise, {
      onSlow: async () => {
        throw new Error('Meta send failed')
      },
    })

    await vi.advanceTimersByTimeAsync(SLOW_TURN_MS + 1)
    work.resolve('answer')
    expect(await promise).toBe('answer')
  })

  it('propagates the real error and still cancels the timer', async () => {
    const onSlow = vi.fn(async () => {})
    await expect(
      withSlowTurnHeartbeat(async () => {
        throw new Error('agent blew up')
      }, { onSlow })
    ).rejects.toThrow('agent blew up')

    await vi.advanceTimersByTimeAsync(SLOW_TURN_MS * 2)
    expect(onSlow).not.toHaveBeenCalled()
  })

  it('honours a custom delay', async () => {
    const onSlow = vi.fn(async () => {})
    const work = deferred<string>()
    const promise = withSlowTurnHeartbeat(() => work.promise, { onSlow, delayMs: 500 })

    await vi.advanceTimersByTimeAsync(501)
    expect(onSlow).toHaveBeenCalledTimes(1)

    work.resolve('x')
    await promise
  })
})
