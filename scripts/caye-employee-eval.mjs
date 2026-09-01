#!/usr/bin/env node
// Runs the frozen Caye Employee Eval baseline through Vitest so TypeScript
// execution uses the same project/runtime as the rest of Caye Bench.
//
// Default:
//   npm run caye:employee:eval
//
// Compare a candidate report produced by the SAME benchmark revision:
//   npm run caye:employee:eval -- --candidate=/path/to/report.json
import { spawnSync } from 'node:child_process'

const candidateArg = process.argv.find((arg) => arg.startsWith('--candidate='))
const candidate = candidateArg?.slice('--candidate='.length)
const env = {
  ...process.env,
  ...(candidate ? { CAYE_EMPLOYEE_CANDIDATE_REPORT: candidate } : {}),
}

const pattern = candidate
  ? 'compares a candidate report against the exact frozen baseline'
  : 'writes the frozen current-main baseline report and scorecard'

const result = spawnSync(
  'npx',
  ['vitest', 'run', 'lib/caye-employee-eval/cli-runner.test.ts', '-t', pattern, '--reporter=verbose'],
  { stdio: 'inherit', env },
)
process.exit(result.status ?? 1)
