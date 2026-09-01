import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateEmployeeBenchmark } from './evaluator'
import { FROZEN_EMPLOYEE_SCENARIOS } from './fixtures'
import { runEmployeeFixtures, type EmployeeEvalAdapter } from './runner'
import { formatEmployeeScorecard } from './scorecard'

const OUTPUT = join(__dirname, '__output__')
const DEFAULT_ADAPTER = join(__dirname, 'production-adapter.ts')

function write(name: string, content: string): void {
  mkdirSync(OUTPUT, { recursive: true })
  writeFileSync(join(OUTPUT, name), content)
}

async function loadAdapter(): Promise<EmployeeEvalAdapter> {
  const configured = process.env.CAYE_EMPLOYEE_EVAL_ADAPTER_MODULE
  const adapterPath = configured
    ? (isAbsolute(configured) ? configured : resolve(process.cwd(), configured))
    : DEFAULT_ADAPTER

  if (!existsSync(adapterPath)) {
    throw new Error(
      `Employee-behavior PR requires a real Employee Eval v1 adapter. Missing ${adapterPath}. ` +
      'Implement/export employeeEvalAdapter from lib/caye-employee-eval/production-adapter.ts (or set CAYE_EMPLOYEE_EVAL_ADAPTER_MODULE). ' +
      'A baseline replay is not a candidate evaluation.',
    )
  }

  const module = await import(pathToFileURL(adapterPath).href)
  const adapter = module.employeeEvalAdapter as EmployeeEvalAdapter | undefined
  if (!adapter?.reset || !adapter?.handle || !adapter?.snapshot) {
    throw new Error(`${adapterPath} must export employeeEvalAdapter implementing reset(), handle(), and snapshot().`)
  }
  return adapter
}

describe('Caye Employee Eval candidate runner', () => {
  it('runs frozen Employee Eval v1 scenarios against the PR implementation', async () => {
    const adapter = await loadAdapter()
    const snapshots = await runEmployeeFixtures(FROZEN_EMPLOYEE_SCENARIOS, adapter)
    const generatedAt = new Date().toISOString()
    const report = evaluateEmployeeBenchmark(FROZEN_EMPLOYEE_SCENARIOS, snapshots, generatedAt)

    const expectedRevision = process.env.GITHUB_SHA || process.env.CAYE_EMPLOYEE_CODE_REVISION
    if (expectedRevision) {
      expect(report.codeRevision).toBe(expectedRevision)
    }

    write('candidate-report.json', `${JSON.stringify(report, null, 2)}\n`)
    write('candidate-scorecard.md', formatEmployeeScorecard(report))
    expect(report.benchmarkVersion).toBe('caye-employee-eval/1.0.0')
    expect(report.scenarios).toHaveLength(FROZEN_EMPLOYEE_SCENARIOS.length)
  })
})
