import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CURRENT_MAIN_BASELINE_OBSERVED_AT, CURRENT_MAIN_BASELINE_SNAPSHOTS } from './baseline-current-main'
import { evaluateEmployeeBenchmark, diffEmployeeEvalReports } from './evaluator'
import { FROZEN_EMPLOYEE_SCENARIOS } from './fixtures'
import { formatEmployeeDiff, formatEmployeeScorecard } from './scorecard'
import type { EmployeeEvalReport } from './types'

const OUTPUT = join(__dirname, '__output__')

function write(name: string, content: string): void {
  mkdirSync(OUTPUT, { recursive: true })
  writeFileSync(join(OUTPUT, name), content)
}

describe('Caye Employee Eval CLI runner', () => {
  it('writes the frozen current-main baseline report and scorecard', () => {
    const report = evaluateEmployeeBenchmark(FROZEN_EMPLOYEE_SCENARIOS, CURRENT_MAIN_BASELINE_SNAPSHOTS, CURRENT_MAIN_BASELINE_OBSERVED_AT)
    write('current-main-baseline.json', `${JSON.stringify(report, null, 2)}\n`)
    write('current-main-scorecard.md', formatEmployeeScorecard(report))
    // The baseline being poor is product information, not a broken evaluator.
    // Never change this expectation to report.passed === true just to green CI.
    expect(report.passed).toBe(false)
    expect(report.scenarios).toHaveLength(FROZEN_EMPLOYEE_SCENARIOS.length)
  })

  it.skipIf(!process.env.CAYE_EMPLOYEE_CANDIDATE_REPORT)('compares a candidate report against the exact frozen baseline', () => {
    const baseline = evaluateEmployeeBenchmark(FROZEN_EMPLOYEE_SCENARIOS, CURRENT_MAIN_BASELINE_SNAPSHOTS, CURRENT_MAIN_BASELINE_OBSERVED_AT)
    const candidate = JSON.parse(readFileSync(process.env.CAYE_EMPLOYEE_CANDIDATE_REPORT!, 'utf8')) as EmployeeEvalReport
    const diff = diffEmployeeEvalReports(baseline, candidate)
    write('candidate-comparison.json', `${JSON.stringify(diff, null, 2)}\n`)
    write('candidate-comparison.md', formatEmployeeDiff(diff))
    expect(diff.comparable).toBe(true)
    // Candidate comparisons may improve or remain poor. The file is the evidence.
    // New hard failures are the one automatic regression blocker.
    expect(diff.newHardFailures).toEqual([])
  })
})
