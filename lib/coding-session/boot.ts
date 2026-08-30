import 'server-only'
import { Sandbox } from '@vercel/sandbox'
import { updateCodingSession, insertCodingSessionMessage } from './queries'
import { CODING_BASE_BRANCH, TRUSTED_CODING_REPOSITORY, codingSessionBranch } from './closure-policy'

const REPO_URL = `https://github.com/${TRUSTED_CODING_REPOSITORY}.git`
const SANDBOX_TIMEOUT_MS = 25 * 60_000
const SESSION_TASK_TIMEOUT_MS = 18 * 60_000
const ALLOWED_DOMAINS = ['github.com','*.github.com','codeload.github.com','objects.githubusercontent.com','registry.npmjs.org','*.npmjs.org','api.anthropic.com']
function envOrThrow(name: string): string { const v = process.env[name]; if (!v) throw new Error(`[coding-session] Missing required env var ${name}`); return v }

export async function bootSandboxAndLaunch(sessionId: string, task: string): Promise<void> {
  let sandbox: Sandbox | undefined
  try {
    const githubToken = envOrThrow('SANDBOX_GITHUB_TOKEN')
    const anthropicKey = envOrThrow('SANDBOX_ANTHROPIC_API_KEY')
    const sandboxName = `code-${sessionId}`
    const workBranch = codingSessionBranch(sessionId)
    sandbox = await Sandbox.create({ name: sandboxName, runtime: 'node24', timeout: SANDBOX_TIMEOUT_MS, persistent: false,
      networkPolicy: { allow: ALLOWED_DOMAINS },
      source: { type: 'git', url: REPO_URL, username: 'x-access-token', password: githubToken, depth: 1, revision: CODING_BASE_BRANCH },
      env: { ANTHROPIC_API_KEY: anthropicKey },
    })
    const remoteSet = await sandbox.runCommand('git', ['remote','set-url','origin',`https://x-access-token:${githubToken}@github.com/${TRUSTED_CODING_REPOSITORY}.git`])
    if (remoteSet.exitCode !== 0) throw new Error(`git remote set-url failed: ${await remoteSet.stderr()}`)
    const baseShaResult = await sandbox.runCommand('git', ['rev-parse','HEAD'])
    const baseSha = (await baseShaResult.stdout()).trim()
    const branch = await sandbox.runCommand('git', ['switch','-c',workBranch])
    if (branch.exitCode !== 0) throw new Error(`isolated branch creation failed: ${await branch.stderr()}`)
    const npmCi = await sandbox.runCommand('npm', ['ci'])
    if (npmCi.exitCode !== 0) throw new Error(`npm ci failed: ${await npmCi.stderr()}`)
    const installCli = await sandbox.runCommand('npm', ['install','-g','@anthropic-ai/claude-code'])
    if (installCli.exitCode !== 0) throw new Error(`installing @anthropic-ai/claude-code failed: ${await installCli.stderr()}`)
    await sandbox.writeFiles([{ path: '.caye-task.txt', content: task }])
    const launched = await sandbox.runCommand({ cmd: 'bash', args: ['-lc','claude -p "$(cat .caye-task.txt)" --output-format stream-json --verbose --dangerously-skip-permissions > .caye-output.jsonl 2>&1'], detached: true })
    await updateCodingSession(sessionId, { status:'running', sandbox_name:sandboxName, cmd_id:launched.cmdId, base_commit_sha:baseSha,
      repository_full_name:TRUSTED_CODING_REPOSITORY, base_branch:CODING_BASE_BRANCH, work_branch:workBranch,
      started_at:new Date().toISOString(), timeout_at:new Date(Date.now()+SESSION_TASK_TIMEOUT_MS).toISOString() })
    await insertCodingSessionMessage(sessionId,'system',`Sandbox booted on isolated branch ${workBranch}; main is read-only execution evidence.`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await updateCodingSession(sessionId,{ status:'failed', error:message, engineering_verdict:'failed', observed_outcome:message, prediction_comparison:'contradicted', finished_at:new Date().toISOString() })
    await insertCodingSessionMessage(sessionId,'error',`Boot failed: ${message}`)
    if (sandbox) await sandbox.stop().catch(()=>{})
    throw err
  }
}
