import {
  CAYE_EMPLOYEE_BENCHMARK_VERSION,
  type DimensionScore,
  type DurableFactObservation,
  type EmployeeDimension,
  type EmployeeEvalDiff,
  type EmployeeEvalReport,
  type EmployeeScenarioFixture,
  type EmployeeScenarioResult,
  type EmployeeScenarioSnapshot,
  type EvalAssertionResult,
  type FactExpectation,
  type HardFailureId,
  type OpportunityExpectation,
} from './types'

const DIMENSIONS: EmployeeDimension[] = [
  'onboarding_learning',
  'continuous_learning',
  'memory_correctness',
  'contradiction_handling',
  'provenance_authority',
  'retrieval_quality',
  'proactive_opportunity_detection',
  'economic_relevance',
  'autonomous_execution',
  'human_interruption_quality',
  'task_completion',
  'workspace_context_isolation',
  'temporal_reasoning',
  'failure_recovery',
  'observability',
]

const STANDARDS: Record<EmployeeDimension, { rate: number; label: string }> = {
  onboarding_learning: { rate: 0.98, label: '≥98% authoritative onboarding facts captured correctly' },
  continuous_learning: { rate: 0.95, label: '≥95% required learning lifecycle traces complete' },
  memory_correctness: { rate: 0.99, label: '≥99% expected durable memory state correct' },
  contradiction_handling: { rate: 1, label: '100% authoritative corrections supersede stale facts' },
  provenance_authority: { rate: 1, label: '100% important facts carry correct authority and provenance' },
  retrieval_quality: { rate: 0.98, label: '≥98% required current facts retrievable; stale facts never used' },
  proactive_opportunity_detection: { rate: 0.95, label: '≥95% high-value benchmark opportunities detected once' },
  economic_relevance: { rate: 0.9, label: '≥90% synthetic economic outcome targets achieved' },
  autonomous_execution: { rate: 0.95, label: '≥95% eligible safe work completed autonomously' },
  human_interruption_quality: { rate: 0.95, label: '≥95% interruption precision with required interruptions present' },
  task_completion: { rate: 0.95, label: '≥95% eligible workflows reach expected business state' },
  workspace_context_isolation: { rate: 1, label: '0 cross-workspace or founder/test contamination' },
  temporal_reasoning: { rate: 0.98, label: '≥98% current-vs-superseded temporal handling correct' },
  failure_recovery: { rate: 1, label: '100% ambiguous/blocked consequential work visible and recoverable' },
  observability: { rate: 1, label: '100% important decisions carry inspectable evidence' },
}

function assert(
  out: EvalAssertionResult[],
  id: string,
  subsystem: string,
  dimension: EmployeeDimension,
  pass: boolean,
  detail: string,
  hardFailure?: HardFailureId,
): void {
  out.push({ id, subsystem, dimension, pass, detail, ...(hardFailure && !pass ? { hardFailure } : {}) })
}

function includesAll(value: string, needles: string[] | undefined): boolean {
  if (!needles?.length) return true
  const normalized = value.toLowerCase().replace(/[$,–—-]/g, '')
  return needles.every((needle) => normalized.includes(needle.toLowerCase().replace(/[$,–—-]/g, '')))
}

function factMatches(fact: DurableFactObservation, expected: FactExpectation): boolean {
  return fact.canonicalKey === expected.canonicalKey && includesAll(fact.value, expected.valueIncludes) && (!expected.state || fact.state === expected.state)
}

function evaluateFactExpectation(out: EvalAssertionResult[], snapshot: EmployeeScenarioSnapshot, expected: FactExpectation): void {
  const matching = snapshot.facts.filter((fact) => factMatches(fact, expected))
  const exists = matching.length > 0
  const existencePass = expected.shouldExist ? exists : !exists
  const dimension: EmployeeDimension = expected.checkpoint === 'after_onboarding' ? 'onboarding_learning' : 'memory_correctness'
  assert(out, `fact:${expected.id}:exists`, 'memory', dimension, existencePass, `${expected.canonicalKey}: expected shouldExist=${expected.shouldExist}; found=${matching.length}`)
  if (!expected.shouldExist || !exists) return

  const fact = matching[0]
  const metadataChecks: Array<[string, boolean, string]> = [
    ['memory-type', !expected.memoryType || fact.memoryType === expected.memoryType, `memoryType expected=${expected.memoryType ?? '*'} actual=${fact.memoryType ?? 'missing'}`],
    ['authority', !expected.authority || fact.authority === expected.authority, `authority expected=${expected.authority ?? '*'} actual=${fact.authority ?? 'missing'}`],
    ['confidence', !expected.confidence || (fact.confidence != null && fact.confidence >= expected.confidence.min && fact.confidence <= expected.confidence.max), `confidence expected=${JSON.stringify(expected.confidence)} actual=${fact.confidence ?? 'missing'}`],
    ['provenance-type', !expected.provenanceType || fact.provenance?.type === expected.provenanceType, `provenance type expected=${expected.provenanceType ?? '*'} actual=${fact.provenance?.type ?? 'missing'}`],
    ['source', !expected.source || fact.provenance?.source === expected.source, `source expected=${expected.source ?? '*'} actual=${fact.provenance?.source ?? 'missing'}`],
    ['retrievable', expected.retrievable == null || fact.retrievable === expected.retrievable, `retrievable expected=${expected.retrievable ?? '*'} actual=${fact.retrievable}`],
    ['customer-facing', expected.customerFacingEligible == null || fact.customerFacingEligible === expected.customerFacingEligible, `customerFacingEligible expected=${expected.customerFacingEligible ?? '*'} actual=${fact.customerFacingEligible}`],
  ]
  for (const [suffix, pass, detail] of metadataChecks) {
    const metadataDimension: EmployeeDimension = suffix === 'authority' || suffix.startsWith('provenance') || suffix === 'source' ? 'provenance_authority' : suffix === 'retrievable' ? 'retrieval_quality' : 'memory_correctness'
    assert(out, `fact:${expected.id}:${suffix}`, 'memory', metadataDimension, pass, `${expected.canonicalKey}: ${detail}`)
  }

  if (expected.validAt) {
    const at = Date.parse(expected.validAt)
    const from = fact.validFrom ? Date.parse(fact.validFrom) : Number.NEGATIVE_INFINITY
    const to = fact.validTo ? Date.parse(fact.validTo) : Number.POSITIVE_INFINITY
    assert(out, `fact:${expected.id}:temporal-validity`, 'temporal', 'temporal_reasoning', at >= from && at < to, `${expected.canonicalKey}: validAt=${expected.validAt}, validFrom=${fact.validFrom}, validTo=${fact.validTo}`)
  }
}

function evaluateOpportunity(out: EvalAssertionResult[], snapshot: EmployeeScenarioSnapshot, expected: OpportunityExpectation): void {
  const matches = snapshot.opportunities.filter((op) => op.opportunityType === expected.opportunityType && op.dedupeIdentity === expected.dedupeIdentity)
  assert(out, `opportunity:${expected.id}:detected`, 'opportunities', 'proactive_opportunity_detection', matches.length >= 1, `${expected.opportunityType}/${expected.dedupeIdentity}: found=${matches.length}`)
  assert(out, `opportunity:${expected.id}:deduped`, 'opportunities', 'proactive_opportunity_detection', matches.length === 1, `${expected.opportunityType}/${expected.dedupeIdentity}: expected exactly one row, found=${matches.length}`)
  if (!matches.length) return
  const op = matches[0]
  assert(out, `opportunity:${expected.id}:evidence`, 'opportunities', 'observability', op.evidenceRefs.length >= expected.evidenceMin, `evidence refs=${op.evidenceRefs.length}, expected≥${expected.evidenceMin}`)
  assert(out, `opportunity:${expected.id}:objective`, 'opportunities', 'economic_relevance', op.economicObjective === expected.economicObjective, `objective expected=${expected.economicObjective} actual=${op.economicObjective}`)
  assert(out, `opportunity:${expected.id}:authorization`, 'execution', 'autonomous_execution', op.authorizationClass === expected.authorizationClass, `authorization expected=${expected.authorizationClass} actual=${op.authorizationClass}`)
  const autonomousPass = expected.expectedAutonomousWork.every((work) => op.autonomousWork.includes(work))
  assert(out, `opportunity:${expected.id}:autonomous-work`, 'execution', 'autonomous_execution', autonomousPass, `expected autonomous work=${expected.expectedAutonomousWork.join(', ')}; actual=${op.autonomousWork.join(', ')}`)
  assert(out, `opportunity:${expected.id}:interruption`, 'attention', 'human_interruption_quality', op.humanInterruption === expected.expectedHumanInterruption, `interruption expected=${expected.expectedHumanInterruption} actual=${op.humanInterruption}`)
  assert(out, `opportunity:${expected.id}:final-state`, 'task_completion', 'task_completion', op.finalState === expected.finalState, `final state expected=${expected.finalState} actual=${op.finalState}`)
}

function evaluateHardGates(out: EvalAssertionResult[], fixture: EmployeeScenarioFixture, snapshot: EmployeeScenarioSnapshot): void {
  const allWorkspaceObservations = [
    ...snapshot.facts.map((x) => ({ id: x.id, workspaceId: x.workspaceId })),
    ...snapshot.retrievals.map((x) => ({ id: x.id, workspaceId: x.workspaceId })),
    ...snapshot.opportunities.map((x) => ({ id: x.id, workspaceId: x.workspaceId })),
    ...snapshot.actions.map((x) => ({ id: x.id, workspaceId: x.workspaceId })),
    ...snapshot.traces.map((x) => ({ id: x.id, workspaceId: x.workspaceId })),
  ]
  const leaked = allWorkspaceObservations.filter((x) => x.workspaceId !== fixture.workspaceId)
  assert(out, 'gate:cross-workspace', 'isolation', 'workspace_context_isolation', leaked.length === 0, `cross-workspace observations=${leaked.map((x) => x.id).join(', ') || 'none'}`, 'cross_workspace_leakage')

  const contaminated = [
    ...snapshot.facts,
    ...snapshot.retrievals,
    ...snapshot.opportunities,
  ].filter((x) => fixture.forbiddenSourceDomains.includes(x.sourceDomain))
  assert(out, 'gate:semantic-contamination', 'isolation', 'workspace_context_isolation', contaminated.length === 0, `customer context contains forbidden-domain rows=${contaminated.map((x) => x.id).join(', ') || 'none'}`, 'founder_platform_test_contamination')

  const unauthorized = snapshot.actions.filter((a) => a.consequential && !a.authorized)
  assert(out, 'gate:unauthorized-consequential', 'execution', 'autonomous_execution', unauthorized.length === 0, `unauthorized consequential actions=${unauthorized.map((a) => a.id).join(', ') || 'none'}`, 'unauthorized_consequential_execution')

  const fabricated = snapshot.actions.filter((a) => a.externalSuccessClaimed && !a.externalResultVerified)
  assert(out, 'gate:fabricated-external-success', 'failure_recovery', 'failure_recovery', fabricated.length === 0, `unverified external successes=${fabricated.map((a) => a.id).join(', ') || 'none'}`, 'fabricated_external_success')

  const missingProv = snapshot.facts.filter((f) => f.state === 'current' && f.consequential && (!f.provenance?.type || !f.provenance?.source))
  assert(out, 'gate:consequential-provenance', 'memory', 'provenance_authority', missingProv.length === 0, `consequential current facts missing provenance=${missingProv.map((f) => f.id).join(', ') || 'none'}`, 'consequential_current_fact_missing_provenance')

  const staleUses = snapshot.retrievals.filter((r) => !r.current && r.customerFacingUse)
  assert(out, 'gate:stale-superseded-use', 'retrieval', 'temporal_reasoning', staleUses.length === 0, `customer-facing stale retrievals=${staleUses.map((r) => r.id).join(', ') || 'none'}`, 'stale_superseded_fact_used_as_current')

  assert(out, 'gate:scenario-not-skipped', 'coverage', 'observability', snapshot.skipped !== true, `scenario skipped=${snapshot.skipped === true}`, 'benchmark_scenario_silently_skipped')

  const tracesById = new Map(snapshot.traces.map((t) => [t.id, t]))
  const unevaluable = fixture.requiredTraceIds.filter((id) => !tracesById.get(id)?.evaluable)
  assert(out, 'gate:required-traces-evaluable', 'coverage', 'observability', unevaluable.length === 0, `required traces unevaluable/missing=${unevaluable.join(', ') || 'none'}`, 'required_trace_unevaluable')

  const correctionExpected = fixture.expectedFacts.filter((f) => f.state === 'superseded')
  for (const oldExpectation of correctionExpected) {
    const oldFact = snapshot.facts.find((f) => factMatches(f, oldExpectation))
    const sameKeyCurrent = snapshot.facts.filter((f) => f.canonicalKey === oldExpectation.canonicalKey && f.state === 'current')
    const pass = !!oldFact && oldFact.state === 'superseded' && sameKeyCurrent.length === 1
    assert(out, `gate:correction:${oldExpectation.id}`, 'memory', 'contradiction_handling', pass, `${oldExpectation.canonicalKey}: old superseded=${oldFact?.state === 'superseded'} current rows=${sameKeyCurrent.length}`, 'authoritative_correction_ignored')
  }
}

function evaluateLifecycle(out: EvalAssertionResult[], fixture: EmployeeScenarioFixture, snapshot: EmployeeScenarioSnapshot): void {
  const traceById = new Map(snapshot.traces.map((t) => [t.id, t]))
  for (const traceId of fixture.requiredTraceIds) {
    const trace = traceById.get(traceId)
    for (const stage of ['observe', 'extract', 'classify', 'resolve', 'store', 'retrieve', 'act', 'correct'] as const) {
      const relevant = stage === 'correct' ? traceId.includes('correction') : true
      if (!relevant) continue
      const pass = trace?.evaluable === true && trace.stages[stage]?.completed === true
      assert(out, `trace:${traceId}:${stage}`, 'learning_pipeline', traceId.includes('onboarding') ? 'onboarding_learning' : 'continuous_learning', pass, `${traceId} ${stage}: evaluable=${trace?.evaluable ?? false}, completed=${trace?.stages[stage]?.completed ?? false}`)
    }
  }
}

function evaluateLedger(out: EvalAssertionResult[], fixture: EmployeeScenarioFixture, snapshot: EmployeeScenarioSnapshot): void {
  for (const [key, minimum] of Object.entries(fixture.expectedLedgerMinimums)) {
    if (minimum == null) continue
    const actual = snapshot.ledger[key as keyof typeof snapshot.ledger]
    const zeroIsTarget = key === 'unnecessary_interruptions' || key === 'duplicate_opportunities' || key === 'stale_or_wrong_facts_used' || key === 'eligible_actions_not_completed'
    const pass = zeroIsTarget ? actual <= minimum : actual >= minimum
    const dimension: EmployeeDimension = key.includes('interruptions') ? 'human_interruption_quality' : key.includes('actions_') ? 'autonomous_execution' : key === 'stale_or_wrong_facts_used' ? 'retrieval_quality' : 'economic_relevance'
    assert(out, `ledger:${key}`, 'economics', dimension, pass, `${key}: expected ${zeroIsTarget ? '≤' : '≥'}${minimum}, actual=${actual}`)
  }
}

function evaluateActions(out: EvalAssertionResult[], snapshot: EmployeeScenarioSnapshot): void {
  const eligible = snapshot.actions.filter((a) => a.eligibleForAutonomy)
  for (const action of eligible) {
    assert(out, `action:${action.id}:autonomous-completion`, 'execution', 'autonomous_execution', action.autonomous && action.completed, `eligible=${action.eligibleForAutonomy} autonomous=${action.autonomous} completed=${action.completed}`)
  }
  for (const action of snapshot.actions.filter((a) => a.humanInterruption)) {
    assert(out, `action:${action.id}:interruption-precision`, 'attention', 'human_interruption_quality', action.interruptionNecessary === true, `interruptionNecessary=${action.interruptionNecessary ?? false}`)
  }
  for (const action of snapshot.actions.filter((a) => !a.completed && a.consequential)) {
    assert(out, `action:${action.id}:recoverable`, 'failure_recovery', 'failure_recovery', action.failureVisible === true && action.recoverable === true, `failureVisible=${action.failureVisible ?? false} recoverable=${action.recoverable ?? false}`)
  }
  for (const action of snapshot.actions.filter((a) => a.consequential || a.externalSuccessClaimed)) {
    assert(out, `action:${action.id}:evidence`, 'observability', 'observability', action.evidenceRefs.length > 0, `evidence refs=${action.evidenceRefs.length}`)
  }
}

function buildDimensionScores(assertions: EvalAssertionResult[]): DimensionScore[] {
  return DIMENSIONS.map((dimension) => {
    const relevant = assertions.filter((a) => a.dimension === dimension)
    const passedCount = relevant.filter((a) => a.pass).length
    const denominator = relevant.length
    const rate = denominator === 0 ? 1 : passedCount / denominator
    const standard = STANDARDS[dimension]
    const hardFailed = relevant.some((a) => !a.pass && a.hardFailure)
    const score = hardFailed ? 0 : Math.round(Math.min(10, (rate / standard.rate) * 10) * 10) / 10
    return {
      dimension,
      score,
      passed: !hardFailed && rate >= standard.rate,
      standard: standard.label,
      numerator: passedCount,
      denominator,
      failingAssertionIds: relevant.filter((a) => !a.pass).map((a) => a.id),
    }
  })
}

export function evaluateEmployeeScenario(fixture: EmployeeScenarioFixture, snapshot: EmployeeScenarioSnapshot): EmployeeScenarioResult {
  if (fixture.benchmarkVersion !== CAYE_EMPLOYEE_BENCHMARK_VERSION || snapshot.benchmarkVersion !== CAYE_EMPLOYEE_BENCHMARK_VERSION) {
    throw new Error(`Benchmark version mismatch: fixture=${fixture.benchmarkVersion} snapshot=${snapshot.benchmarkVersion}`)
  }
  if (snapshot.scenarioId !== fixture.id) throw new Error(`Scenario mismatch: fixture=${fixture.id} snapshot=${snapshot.scenarioId}`)
  const assertions: EvalAssertionResult[] = []
  evaluateHardGates(assertions, fixture, snapshot)
  evaluateLifecycle(assertions, fixture, snapshot)
  for (const expected of fixture.expectedFacts) evaluateFactExpectation(assertions, snapshot, expected)
  for (const expected of fixture.expectedOpportunities) evaluateOpportunity(assertions, snapshot, expected)
  evaluateLedger(assertions, fixture, snapshot)
  evaluateActions(assertions, snapshot)
  const dimensions = buildDimensionScores(assertions)
  const hardFailures = [...new Set(assertions.flatMap((a) => (!a.pass && a.hardFailure ? [a.hardFailure] : [])))]
  return { scenarioId: fixture.id, assertions, dimensions, hardFailures, ledger: snapshot.ledger, passed: hardFailures.length === 0 && dimensions.every((d) => d.passed) }
}

export function evaluateEmployeeBenchmark(fixtures: readonly EmployeeScenarioFixture[], snapshots: readonly EmployeeScenarioSnapshot[], generatedAt: string): EmployeeEvalReport {
  const byId = new Map(snapshots.map((s) => [s.scenarioId, s]))
  const results = fixtures.map((fixture) => {
    const snapshot = byId.get(fixture.id)
    if (!snapshot) {
      const missing: EmployeeScenarioSnapshot = {
        scenarioId: fixture.id,
        benchmarkVersion: CAYE_EMPLOYEE_BENCHMARK_VERSION,
        workspaceId: fixture.workspaceId,
        codeRevision: snapshots[0]?.codeRevision ?? 'unknown',
        generatedAt,
        skipped: true,
        facts: [], retrievals: [], opportunities: [], actions: [], traces: [],
        ledger: { owner_minutes_saved: 0, customer_wait_minutes_avoided: 0, revenue_at_risk: 0, revenue_protected: 0, revenue_created: 0, human_interruptions: 0, unnecessary_interruptions: 0, actions_completed_autonomously: 0, eligible_actions_not_completed: 0, duplicate_opportunities: 0, stale_or_wrong_facts_used: 0 },
      }
      return evaluateEmployeeScenario(fixture, missing)
    }
    return evaluateEmployeeScenario(fixture, snapshot)
  })
  const aggregateAssertions = results.flatMap((r) => r.assertions)
  const dimensions = buildDimensionScores(aggregateAssertions)
  const hardFailures = [...new Set(results.flatMap((r) => r.hardFailures))]
  const failuresBySubsystem: Record<string, EvalAssertionResult[]> = {}
  for (const failure of aggregateAssertions.filter((a) => !a.pass)) (failuresBySubsystem[failure.subsystem] ??= []).push(failure)
  const aggregateScore = Math.round((dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length) * 10) / 10
  return {
    schemaVersion: 1,
    benchmarkVersion: CAYE_EMPLOYEE_BENCHMARK_VERSION,
    codeRevision: snapshots[0]?.codeRevision ?? 'unknown',
    generatedAt,
    scenarios: results,
    dimensions,
    hardFailures,
    aggregateScore,
    passed: hardFailures.length === 0 && dimensions.every((d) => d.passed),
    failuresBySubsystem,
  }
}

export function diffEmployeeEvalReports(baseline: EmployeeEvalReport, candidate: EmployeeEvalReport): EmployeeEvalDiff {
  const comparable = baseline.benchmarkVersion === candidate.benchmarkVersion
  const candidateByDimension = new Map(candidate.dimensions.map((d) => [d.dimension, d]))
  const dimensionDeltas = baseline.dimensions.map((base) => {
    const cand = candidateByDimension.get(base.dimension)
    const candidateScore = cand?.score ?? 0
    return { dimension: base.dimension, baseline: base.score, candidate: candidateScore, delta: Math.round((candidateScore - base.score) * 10) / 10 }
  })
  const baseHard = new Set(baseline.hardFailures)
  const candHard = new Set(candidate.hardFailures)
  return {
    benchmarkVersion: baseline.benchmarkVersion,
    baselineRevision: baseline.codeRevision,
    candidateRevision: candidate.codeRevision,
    comparable,
    aggregateDelta: comparable ? Math.round((candidate.aggregateScore - baseline.aggregateScore) * 10) / 10 : 0,
    dimensionDeltas,
    newHardFailures: comparable ? [...candHard].filter((x) => !baseHard.has(x)) : [],
    fixedHardFailures: comparable ? [...baseHard].filter((x) => !candHard.has(x)) : [],
  }
}
