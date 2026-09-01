import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateEmployeeBenchmark } from './evaluator'
import { FROZEN_EMPLOYEE_SCENARIOS } from './fixtures'
import { runEmployeeFixtures } from './runner'
import { formatEmployeeScorecard } from './scorecard'
import { loadEmployeeEvalAdapter } from './adapter-loader'

const OUTPUT = join(__dirname, '__output__')

function write(name: string, content: string): void {
  mkdirSync(OUTPUT, { recursive: true })
  writeFileSync(join(OUTPUT, name), content)
}

describe('Caye Employee Eval candidate runner', () => {
  it('runs frozen Employee Eval v1 scenarios against the PR implementation', async () => {
    const adapter = await loadEmployeeEvalAdapter()
    const snapshots = await runEmployeeFixtures(FROZEN_EMPLOYEE_SCENARIOS, adapter)
    const generatedAt = new Date().toISOString()
    const report = evaluateEmployeeBenchmark(FROZEN_EMPLOYEE_SCENARIOS, snapshots, generatedAt)

    // The adapter independently verifies git rev-parse HEAD against this value.
    // The report must carry the same exact candidate revision.
    const expectedRevision = process.env.CAYE_EMPLOYEE_CODE_REVISION || process.env.GITHUB_SHA
    if (expectedRevision) expect(report.codeRevision).toBe(expectedRevision)

    write('candidate-report.json', `${JSON.stringify(report, null, 2)}\n`)
    write('candidate-scorecard.md', formatEmployeeScorecard(report))
    expect(report.benchmarkVersion).toBe('caye-employee-eval/1.0.0')
    expect(report.scenarios).toHaveLength(FROZEN_EMPLOYEE_SCENARIOS.length)
  })
})
