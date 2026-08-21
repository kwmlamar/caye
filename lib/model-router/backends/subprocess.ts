import 'server-only'
import { spawn } from 'node:child_process'

/**
 * Shared subprocess runner for the two subscription CLI backends. Section
 * 12 of the brief line by line:
 *   - no shell injection: spawn() with an argv array, shell:false always
 *     (node's default — never pass {shell: true})
 *   - bounded execution time: `timeoutMs` + SIGKILL on expiry
 *   - clean cancellation: caller's AbortSignal kills the child immediately
 *   - sanitized prompt transport: prompt text goes over stdin, never
 *     interpolated into argv or a shell string
 *   - no arbitrary user-controlled CLI flags: `args` is built by the
 *     backend module from a fixed template, never from founder-authored
 *     text
 *   - explicit environment: caller passes exactly the env vars needed,
 *     no `...process.env` spread
 *   - stdout/stderr captured to bounded in-memory buffers, not inherited
 */
export interface RunSubprocessOptions {
  command: string
  args: string[]
  stdin?: string
  env: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs: number
  signal: AbortSignal
  /** Refuse to buffer more than this many bytes of stdout/stderr each. */
  maxBufferBytes?: number
}

export interface SubprocessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export class SubprocessSpawnError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message)
    this.name = 'SubprocessSpawnError'
  }
}

export function runSubprocess(opts: RunSubprocessOptions): Promise<SubprocessResult> {
  const maxBuffer = opts.maxBufferBytes ?? 2 * 1024 * 1024

  return new Promise((resolve, reject) => {
    const child = spawn(opts.command, opts.args, {
      env: opts.env,
      cwd: opts.cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)

    const onAbort = () => {
      child.kill('SIGKILL')
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => {
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new SubprocessSpawnError(err.message, err.code))
    })

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString('utf8')
    })

    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ exitCode, stdout, stderr, timedOut })
    })

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin, 'utf8')
    }
    child.stdin.end()
  })
}
