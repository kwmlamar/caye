import 'server-only'
import type { Sandbox } from '@vercel/sandbox'
import { updateCodingSession, insertCodingSessionMessage } from './queries'

interface GateStep {
  label: string
  cmd: string
  args: string[]
}

const STEPS: GateStep[] = [
  // Fails loud on a real conflict rather than silently overwriting a
  // concurrent human push — never force-pushed, ever.
  { label: 'git pull --rebase', cmd: 'git', args: ['pull', '--rebase', 'origin', 'main'] },
  { label: 'npm test', cmd: 'npm', args: ['test'] },
  { label: 'npm run build', cmd: 'npm', args: ['run', 'build'] },
]

/**
 * Runs the pre-push gate in order, stopping at the first failure. Never
 * force-pushes. Every step's output is posted as a message row (not just
 * stashed in a DB column) so the founder sees exactly what failed in the
 * thread itself. This function only ever runs git/npm — it never touches
 * Supabase migrations, per the decision that DB changes stay manual.
 */
export async function runGateAndPush(sandbox: Sandbox, sessionId: string): Promise<void> {
  await updateCodingSession(sessionId, { status: 'testing' })

  for (const step of STEPS) {
    const result = await sandbox.runCommand(step.cmd, step.args)
    const output = await result.output('both')

    if (result.exitCode !== 0) {
      await insertCodingSessionMessage(
        sessionId,
        'error',
        `${step.label} failed (exit ${result.exitCode}):\n${output}`.slice(0, 4000)
      )
      await updateCodingSession(sessionId, {
        status: 'failed',
        gate_test_passed: step.label === 'npm test' ? false : undefined,
        gate_build_passed: step.label === 'npm run build' ? false : undefined,
        gate_output: output.slice(0, 8000),
        finished_at: new Date().toISOString(),
      })
      return
    }

    await insertCodingSessionMessage(sessionId, 'system', `${step.label} passed.`)
    if (step.label === 'npm test') await updateCodingSession(sessionId, { gate_test_passed: true })
    if (step.label === 'npm run build') await updateCodingSession(sessionId, { gate_build_passed: true })
  }

  const push = await sandbox.runCommand('git', ['push', 'origin', 'main'])
  const pushOutput = await push.output('both')
  if (push.exitCode !== 0) {
    await insertCodingSessionMessage(sessionId, 'error', `git push failed:\n${pushOutput}`.slice(0, 4000))
    await updateCodingSession(sessionId, {
      status: 'failed',
      gate_output: pushOutput.slice(0, 8000),
      finished_at: new Date().toISOString(),
    })
    return
  }

  const shaResult = await sandbox.runCommand('git', ['rev-parse', 'HEAD'])
  const finalSha = (await shaResult.stdout()).trim()

  await insertCodingSessionMessage(sessionId, 'summary', `Pushed to main: ${finalSha}`)
  await updateCodingSession(sessionId, {
    status: 'pushed',
    final_commit_sha: finalSha,
    finished_at: new Date().toISOString(),
  })
}
