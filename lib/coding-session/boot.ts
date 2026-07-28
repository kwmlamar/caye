import 'server-only'
import { Sandbox } from '@vercel/sandbox'
import { updateCodingSession, insertCodingSessionMessage } from './queries'

const REPO_URL = 'https://github.com/kwmlamar/caye.git'
const SANDBOX_TIMEOUT_MS = 25 * 60_000 // sandbox hard-stops here regardless of task status
const SESSION_TASK_TIMEOUT_MS = 18 * 60_000 // our own deadline, checked by poll.ts, leaves buffer for gate+push+teardown before the sandbox itself times out

// Sandbox only ever needs to reach GitHub (clone/push), npm (install deps +
// the Claude Code CLI), and Anthropic (run Claude Code itself). No Supabase,
// no WhatsApp, no other Caye infra — this list IS the isolation boundary,
// not a suggestion.
const ALLOWED_DOMAINS = [
  'github.com',
  '*.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'registry.npmjs.org',
  '*.npmjs.org',
  'api.anthropic.com',
]

function envOrThrow(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`[coding-session] Missing required env var ${name}`)
  return v
}

/**
 * Boots a sandbox, clones `main`, installs deps + the Claude Code CLI, and
 * launches it detached against the task. Runs synchronously inside the
 * `/code` API route (bounded — clone + npm ci + global install is expected
 * in the tens of seconds, not milliseconds) rather than via fire-and-forget,
 * since Vercel doesn't guarantee background work continues reliably past a
 * returned response without deliberate waitUntil/after plumbing. The actual
 * multi-minute coding run happens detached, polled by a separate cron tick
 * (see poll.ts) — this function only covers the boot phase.
 */
export async function bootSandboxAndLaunch(sessionId: string, task: string): Promise<void> {
  // `sandbox` starts unset so the catch block below can tell "never
  // created" (e.g. a missing env var, or Sandbox.create itself failing)
  // apart from "created but a later step failed" — only the latter has
  // something to call .stop() on.
  let sandbox: Sandbox | undefined

  try {
    const githubToken = envOrThrow('SANDBOX_GITHUB_TOKEN')
    const anthropicKey = envOrThrow('SANDBOX_ANTHROPIC_API_KEY')

    const sandboxName = `code-${sessionId}`

    sandbox = await Sandbox.create({
      name: sandboxName,
      runtime: 'node24',
      timeout: SANDBOX_TIMEOUT_MS,
      persistent: false,
      networkPolicy: { allow: ALLOWED_DOMAINS },
      source: {
        type: 'git',
        url: REPO_URL,
        username: 'x-access-token',
        password: githubToken,
        depth: 1,
        revision: 'main',
      },
      // Deliberately minimal — this is the entire env inside the sandbox.
      // No Supabase URL/keys, no product ANTHROPIC_API_KEY, no WhatsApp
      // tokens. The sandbox structurally cannot reach live Caye data.
      env: { ANTHROPIC_API_KEY: anthropicKey },
    })

    // Don't rely on the initial git-source clone auth persisting for the
    // later `git push` in gate-and-push.ts — re-set it explicitly.
    const remoteSet = await sandbox.runCommand('git', [
      'remote', 'set-url', 'origin',
      `https://x-access-token:${githubToken}@github.com/kwmlamar/caye.git`,
    ])
    if (remoteSet.exitCode !== 0) {
      throw new Error(`git remote set-url failed: ${await remoteSet.stderr()}`)
    }

    const baseShaResult = await sandbox.runCommand('git', ['rev-parse', 'HEAD'])
    const baseSha = (await baseShaResult.stdout()).trim()

    const npmCi = await sandbox.runCommand('npm', ['ci'])
    if (npmCi.exitCode !== 0) {
      throw new Error(`npm ci failed: ${await npmCi.stderr()}`)
    }

    const installCli = await sandbox.runCommand('npm', ['install', '-g', '@anthropic-ai/claude-code'])
    if (installCli.exitCode !== 0) {
      throw new Error(`installing @anthropic-ai/claude-code failed: ${await installCli.stderr()}`)
    }

    // Task written to a file (not interpolated into a shell string) to
    // avoid quoting/injection issues with founder-authored text.
    await sandbox.writeFiles([{ path: '.caye-task.txt', content: task }])

    // Detached, output redirected to a file rather than the SDK's live
    // stdout option — a live stream doesn't survive across the cold,
    // separate serverless invocations that poll.ts runs in. A file +
    // byte-cursor (see poll.ts) is what makes cross-tick polling work.
    const launched = await sandbox.runCommand({
      cmd: 'bash',
      args: [
        '-lc',
        'claude -p "$(cat .caye-task.txt)" --output-format stream-json --verbose --dangerously-skip-permissions > .caye-output.jsonl 2>&1',
      ],
      detached: true,
    })

    await updateCodingSession(sessionId, {
      status: 'running',
      sandbox_name: sandboxName,
      cmd_id: launched.cmdId,
      base_commit_sha: baseSha,
      started_at: new Date().toISOString(),
      timeout_at: new Date(Date.now() + SESSION_TASK_TIMEOUT_MS).toISOString(),
    })

    await insertCodingSessionMessage(sessionId, 'system', 'Sandbox booted, session running.')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await updateCodingSession(sessionId, {
      status: 'failed',
      error: message,
      finished_at: new Date().toISOString(),
    })
    await insertCodingSessionMessage(sessionId, 'error', `Boot failed: ${message}`)
    if (sandbox) await sandbox.stop().catch(() => {})
    throw err
  }
}
