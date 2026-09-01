import type { EmployeeEvalDiff, EmployeeEvalReport } from './types'

export function formatEmployeeScorecard(report: EmployeeEvalReport): string {
  const lines: string[] = []
  lines.push(`# Caye Employee Eval`)
  lines.push('')
  lines.push(`Benchmark: \`${report.benchmarkVersion}\``)
  lines.push(`Code revision: \`${report.codeRevision}\``)
  lines.push(`Generated: ${report.generatedAt}`)
  lines.push(`Overall: **${report.aggregateScore.toFixed(1)}/10** — ${report.passed ? 'PASS' : 'FAIL'}`)
  lines.push(`Hard failures: ${report.hardFailures.length ? report.hardFailures.map((x) => `\`${x}\``).join(', ') : 'none'}`)
  lines.push('')
  lines.push('| Dimension | Score | Standard | Result |')
  lines.push('| --- | ---: | --- | --- |')
  for (const d of report.dimensions) lines.push(`| ${d.dimension} | ${d.score.toFixed(1)}/10 | ${d.standard} | ${d.passed ? 'PASS' : 'FAIL'} |`)
  lines.push('')
  lines.push('## Failing assertions by subsystem')
  lines.push('')
  const subsystems = Object.entries(report.failuresBySubsystem)
  if (!subsystems.length) lines.push('None.')
  for (const [subsystem, failures] of subsystems) {
    lines.push(`### ${subsystem}`)
    lines.push('')
    for (const failure of failures) {
      const hard = failure.hardFailure ? ` [HARD: ${failure.hardFailure}]` : ''
      lines.push(`- **${failure.id}** (${failure.dimension})${hard}: ${failure.detail}`)
    }
    lines.push('')
  }
  lines.push('## Economic ledger')
  lines.push('')
  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.scenarioId}`)
    lines.push('')
    for (const [key, value] of Object.entries(scenario.ledger)) lines.push(`- ${key}: ${value}`)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

export function formatEmployeeDiff(diff: EmployeeEvalDiff): string {
  const lines = [
    '# Caye Employee Eval Comparison',
    '',
    `Benchmark: \`${diff.benchmarkVersion}\``,
    `Baseline: \`${diff.baselineRevision}\``,
    `Candidate: \`${diff.candidateRevision}\``,
    `Comparable: ${diff.comparable ? 'yes' : 'NO'}`,
    `Aggregate delta: ${diff.aggregateDelta >= 0 ? '+' : ''}${diff.aggregateDelta.toFixed(1)}`,
    `New hard failures: ${diff.newHardFailures.join(', ') || 'none'}`,
    `Fixed hard failures: ${diff.fixedHardFailures.join(', ') || 'none'}`,
    '',
    '| Dimension | Baseline | Candidate | Delta |',
    '| --- | ---: | ---: | ---: |',
    ...diff.dimensionDeltas.map((d) => `| ${d.dimension} | ${d.baseline.toFixed(1)} | ${d.candidate.toFixed(1)} | ${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(1)} |`),
  ]
  return `${lines.join('\n')}\n`
}
