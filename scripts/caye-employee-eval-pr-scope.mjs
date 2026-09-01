#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const base = process.env.CAYE_EMPLOYEE_EVAL_BASE_SHA || process.env.GITHUB_BASE_SHA
if (!base) {
  console.error('Missing CAYE_EMPLOYEE_EVAL_BASE_SHA/GITHUB_BASE_SHA; refusing to guess Employee Eval PR scope.')
  process.exit(2)
}

const head = process.env.CAYE_EMPLOYEE_EVAL_HEAD_SHA || process.env.GITHUB_SHA || 'HEAD'
const changed = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' })
  .split('\n')
  .map((x) => x.trim())
  .filter(Boolean)

function clearlyNonBehavioral(path) {
  if (path.startsWith('.github/')) return true
  if (path.startsWith('docs/')) return true
  if (path.startsWith('lib/caye-employee-eval/')) return true
  if (/^scripts\/caye-employee-eval.*\.mjs$/.test(path)) return true
  if (/\.md$/i.test(path)) return true
  if (/(^|\/)__tests__\//.test(path)) return true
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return true
  return false
}

const behaviorFiles = changed.filter((path) => !clearlyNonBehavioral(path))
const requiresEval = behaviorFiles.length > 0

console.log(`Changed files (${changed.length}):`)
for (const path of changed) console.log(`  ${path}`)
console.log(`Employee-behavior-sensitive files (${behaviorFiles.length}):`)
for (const path of behaviorFiles) console.log(`  ${path}`)
console.log(`requires_eval=${requiresEval}`)

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `requires_eval=${requiresEval}\n`)
  appendFileSync(process.env.GITHUB_OUTPUT, `behavior_file_count=${behaviorFiles.length}\n`)
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    '## Employee Eval PR scope',
    '',
    `Requires Employee Eval v1: **${requiresEval ? 'YES' : 'no'}**`,
    '',
  ]
  if (behaviorFiles.length) {
    lines.push('Runtime/behavior-sensitive files:')
    lines.push('')
    for (const path of behaviorFiles) lines.push(`- \`${path}\``)
  } else {
    lines.push('Only evaluator infrastructure, CI, documentation, or test-only files changed.')
  }
  lines.push('')
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
}
