import 'server-only'
import type { Sandbox } from '@vercel/sandbox'
import { getCodingSession, updateCodingSession, insertCodingSessionMessage } from './queries'
import { evaluateEngineeringClosure } from './closure-policy'

interface GateStep { label: string; cmd: string; args: string[] }

const STEPS: GateStep[] = [
  { label: 'git pull --rebase', cmd: 'git', args: ['pull', '--rebase', 'origin', 'main'] },
  { label: 'npm test', cmd: 'npm', args: ['test'] },
  { label: 'npm run build', cmd: 'npm', args: ['run', 'build'] },
]

/**
 * Verifies the patch and pushes ONLY the isolated review branch. This function
 * has no path that can merge or push to main. Merge/deploy require separate
 * founder authority and later production observation.
 */
export async function runGateAndPush(sandbox: Sandbox, sessionId: string): Promise<void> {
  const session = await getCodingSession(sessionId)
  if (!session?.work_branch) throw new Error('Coding session has no isolated work branch')
  if (session.work_branch === 'main' || session.work_branch === session.base_branch) {
    throw new Error('Refusing engineering execution on protected base branch')
  }

  await updateCodingSession(sessionId, { status: 'testing' })
  let testPassed: boolean | null = null
  let buildPassed: boolean | null = null

  for (const step of STEPS) {
    const result = await sandbox.runCommand(step.cmd, step.args)
    const output = await result.output('both')
    if (step.label === 'npm test') testPassed = result.exitCode === 0
    if (step.label === 'npm run build') buildPassed = result.exitCode === 0

    if (result.exitCode !== 0) {
      const closure = evaluateEngineeringClosure({ repository: session.repository_full_name, baseBranch: session.base_branch,
        workBranch: session.work_branch, testPassed, buildPassed, branchPushPassed: false, productionObserved: false })
      await insertCodingSessionMessage(sessionId, 'error', `${step.label} failed (exit ${result.exitCode}):\n${output}`.slice(0, 4000))
      await updateCodingSession(sessionId, {
        status: 'failed', gate_test_passed: testPassed, gate_build_passed: buildPassed,
        gate_output: output.slice(0, 8000), observed_outcome: closure.summary,
        prediction_comparison: closure.comparison, engineering_verdict: closure.verdict,
        outcome_environment: closure.environment, production_verified: false,
        execution_evidence: { testPassed, buildPassed, branchPushPassed: false, failedStep: step.label },
        finished_at: new Date().toISOString(),
      })
      return
    }

    await insertCodingSessionMessage(sessionId, 'system', `${step.label} passed.`)
    if (step.label === 'npm test') await updateCodingSession(sessionId, { gate_test_passed: true })
    if (step.label === 'npm run build') await updateCodingSession(sessionId, { gate_build_passed: true })
  }

  const push = await sandbox.runCommand('git', ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${session.work_branch}`])
  const pushOutput = await push.output('both')
  if (push.exitCode !== 0) {
    const closure = evaluateEngineeringClosure({ repository: session.repository_full_name, baseBranch: session.base_branch,
      workBranch: session.work_branch, testPassed: true, buildPassed: true, branchPushPassed: false, productionObserved: false })
    await insertCodingSessionMessage(sessionId, 'error', `review branch push failed:\n${pushOutput}`.slice(0, 4000))
    await updateCodingSession(sessionId, {
      status: 'failed', gate_test_passed: true, gate_build_passed: true, gate_output: pushOutput.slice(0, 8000),
      execution_evidence: { testPassed: true, buildPassed: true, branchPushPassed: false },
      observed_outcome: closure.summary, prediction_comparison: closure.comparison,
      engineering_verdict: closure.verdict, outcome_environment: closure.environment,
      production_verified: false, merge_authorized: false, deploy_authorized: false,
      finished_at: new Date().toISOString(),
    })
    return
  }

  const shaResult = await sandbox.runCommand('git', ['rev-parse', 'HEAD'])
  const finalSha = (await shaResult.stdout()).trim()
  const closure = evaluateEngineeringClosure({ repository: session.repository_full_name, baseBranch: session.base_branch,
    workBranch: session.work_branch, testPassed: true, buildPassed: true, branchPushPassed: true, productionObserved: false })

  await insertCodingSessionMessage(sessionId, 'summary', `Review branch pushed: ${session.work_branch} @ ${finalSha}. Main was not modified. ${closure.summary}`)
  await updateCodingSession(sessionId, {
    status: 'pushed', final_commit_sha: finalSha,
    execution_evidence: { testPassed: true, buildPassed: true, branchPushPassed: true, branch: session.work_branch, commitSha: finalSha },
    observed_outcome: closure.summary, prediction_comparison: closure.comparison,
    engineering_verdict: closure.verdict, outcome_environment: closure.environment,
    production_verified: closure.productionVerified, merge_authorized: false, deploy_authorized: false,
    finished_at: new Date().toISOString(),
  })
}
