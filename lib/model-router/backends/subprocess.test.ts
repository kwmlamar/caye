import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { runSubprocess, SubprocessSpawnError } from './subprocess'

describe('runSubprocess', () => {
  it('captures stdout from a real process', async () => {
    const result = await runSubprocess({
      command: 'printf',
      args: ['hello world'],
      env: { PATH: process.env.PATH ?? '', NODE_ENV: process.env.NODE_ENV },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello world')
  })

  it('passes stdin through without shell interpolation (no shell injection surface)', async () => {
    // Argument contains shell metacharacters that would be dangerous under
    // shell:true (e.g. `; rm -rf /`); spawn() with an argv array never
    // hands this to a shell, so it is passed through literally as one arg.
    const dangerousArg = '$(echo pwned); rm -rf /tmp/should-not-run'
    const result = await runSubprocess({
      command: 'printf',
      args: ['%s', dangerousArg],
      env: { PATH: process.env.PATH ?? '', NODE_ENV: process.env.NODE_ENV },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    expect(result.stdout).toBe(dangerousArg)
  })

  it('kills the process and reports timedOut when it exceeds timeoutMs', async () => {
    const result = await runSubprocess({
      command: 'sleep',
      args: ['5'],
      env: { PATH: process.env.PATH ?? '', NODE_ENV: process.env.NODE_ENV },
      timeoutMs: 200,
      signal: new AbortController().signal,
    })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).not.toBe(0)
  }, 10_000)

  it('kills the process immediately when the AbortSignal fires', async () => {
    const controller = new AbortController()
    const promise = runSubprocess({
      command: 'sleep',
      args: ['5'],
      env: { PATH: process.env.PATH ?? '', NODE_ENV: process.env.NODE_ENV },
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 100)
    const start = Date.now()
    await promise
    expect(Date.now() - start).toBeLessThan(2_000)
  }, 10_000)

  it('rejects with SubprocessSpawnError (not a generic throw) when the binary does not exist', async () => {
    await expect(
      runSubprocess({
        command: 'this-binary-does-not-exist-on-any-machine',
        args: [],
        env: { PATH: process.env.PATH ?? '', NODE_ENV: process.env.NODE_ENV },
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      })
    ).rejects.toBeInstanceOf(SubprocessSpawnError)
  })
})
