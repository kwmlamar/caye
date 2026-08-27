import type { ReplayComparisonReport } from './compare'

/**
 * replay/format-report.ts — the human-readable rendering of a
 * `ReplayComparisonReport`, for terminal output from the CLI. The
 * machine-readable form is the report object itself (JSON-serializable
 * as-is); this is a second view of the same data, not a second source
 * of truth.
 */
export function formatComparisonReportHuman(report: ReplayComparisonReport): string {
  const lines: string[] = []
  lines.push(`Caye Bench v2 — replay run ${report.runId}`)
  lines.push(`Trace: ${report.traceId} — ${report.sourceDescription}`)
  if (report.incidentRefs.length > 0) lines.push(`Incident refs: ${report.incidentRefs.join(', ')}`)
  lines.push(`Generated: ${report.generatedAt}`)
  lines.push('')

  lines.push(`SAFETY VERDICT: ${report.safetyVerdict}`)
  if (report.safetyRegressions.length > 0) {
    lines.push(`  ⚠ ${report.safetyRegressions.length} NEW safety violation(s) not present historically:`)
    for (const v of report.safetyRegressions) lines.push(`    - ${v.invariant}: ${v.detail}`)
  }
  if (report.safetyImprovements.length > 0) {
    lines.push(`  ✓ ${report.safetyImprovements.length} historical safety violation(s) no longer reproduced:`)
    for (const v of report.safetyImprovements) lines.push(`    - ${v.invariant}: ${v.detail}`)
  }
  if (report.persistingSafetyIssues.length > 0) {
    lines.push(`  ⚠ ${report.persistingSafetyIssues.length} safety violation(s) present in BOTH historical and replay:`)
    for (const v of report.persistingSafetyIssues) lines.push(`    - ${v.invariant}: ${v.detail}`)
  }
  if (report.safetyRegressions.length === 0 && report.persistingSafetyIssues.length === 0 && report.safetyImprovements.length === 0) {
    lines.push('  No hard-invariant violations, historically or in replay.')
  }
  lines.push('')

  lines.push(`BEHAVIOR VERDICT: ${report.behaviorVerdict}`)
  for (const d of report.behaviorDeltas) {
    const arrow = d.direction === 'better' ? '↑ better' : d.direction === 'worse' ? '↓ worse' : '= same'
    lines.push(`  ${d.metric}: historical=${d.historical} replay=${d.replay} (${arrow})`)
  }
  lines.push('')

  lines.push(`Quality score — historical: ${report.historical.qualityScore}, replay: ${report.replay.qualityScore}`)
  lines.push(`Replay produced ${report.replay.effects.length} effect(s) across ${report.replay.eventsProcessed} event(s).`)
  lines.push('')

  const consequential = report.replay.effects.filter((e) => e.consequential)
  if (consequential.length > 0) {
    lines.push('Proposed consequential actions this replay run:')
    for (const e of consequential) lines.push(`  - ${e.outcome}: ${e.kind} — ${e.claim ?? e.metadata?.tool ?? e.id}`)
    lines.push('')
  }
  const interruptions = report.replay.effects.filter((e) => e.operatorInterruption)
  if (interruptions.length > 0) {
    lines.push('Operator interruptions this replay run:')
    for (const e of interruptions) lines.push(`  - ${e.claim ?? e.id}`)
    lines.push('')
  }

  for (const note of report.expectedChanges) lines.push(`Note: ${note}`)

  return lines.join('\n')
}
