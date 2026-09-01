import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { evaluateEmployeeBenchmark } from './evaluator'
import { loadEmployeeEvalAdapter } from './adapter-loader'
import { BIMINI_EMPLOYEE_SCENARIO, ODS_EMPLOYEE_SCENARIO } from './fixtures'
import { FROZEN_EMPLOYEE_EVENT_STREAMS } from './scenario-events'
import { runEmployeeScenario } from './runner'
import { employeeEvalAdapter, __employeeEvalAdapterTestKit } from './production-adapter'
import { ZERO_LEDGER, type EmployeeScenarioSnapshot } from './types'

const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const priorExpectedSha = process.env.CAYE_EMPLOYEE_CODE_REVISION

beforeAll(() => {
  process.env.CAYE_EMPLOYEE_CODE_REVISION = actualSha
})

afterAll(async () => {
  if (priorExpectedSha == null) delete process.env.CAYE_EMPLOYEE_CODE_REVISION
  else process.env.CAYE_EMPLOYEE_CODE_REVISION = priorExpectedSha
  await __employeeEvalAdapterTestKit.close()
})

describe('Employee Eval production adapter contract', () => {
  it('candidate runner refuses a missing adapter instead of replaying a baseline', async () => {
    await expect(loadEmployeeEvalAdapter('/definitely/missing/caye-production-adapter.ts')).rejects.toThrow(/baseline replay is not a candidate evaluation/i)
  })

  it('records and independently verifies the exact candidate SHA', async () => {
    await employeeEvalAdapter.reset(ODS_EMPLOYEE_SCENARIO)
    expect(__employeeEvalAdapterTestKit.actualRevision).toBe(actualSha)
  })

  it('applies candidate-required migrations before scenario execution', async () => {
    await employeeEvalAdapter.reset(ODS_EMPLOYEE_SCENARIO)
    expect(__employeeEvalAdapterTestKit.migrations).toContain('supabase/migrations/20260901_continuous_business_learning.sql')
  })

  it('resets durable scenario state between ODS and Bimini', async () => {
    const first = FROZEN_EMPLOYEE_EVENT_STREAMS['ods-construction-end-to-end-v1'][0]
    await employeeEvalAdapter.reset(ODS_EMPLOYEE_SCENARIO)
    await employeeEvalAdapter.handle(first, { scenario: ODS_EMPLOYEE_SCENARIO, eventIndex: 0, priorEvents: [] })
    expect((await __employeeEvalAdapterTestKit.counts()).business_learning_observations).toBeGreaterThan(0)

    await employeeEvalAdapter.reset(BIMINI_EMPLOYEE_SCENARIO)
    const counts = await __employeeEvalAdapterTestKit.counts()
    expect(counts.customers).toBe(1)
    expect(counts.business_learning_observations).toBe(0)
    expect(counts.business_learning_events).toBe(0)
    expect(counts.business_facts).toBe(0)
  })

  it('invokes the real durable learning pipeline and drains its worker without sleeps', async () => {
    const first = FROZEN_EMPLOYEE_EVENT_STREAMS['ods-construction-end-to-end-v1'][0]
    await employeeEvalAdapter.reset(ODS_EMPLOYEE_SCENARIO)
    await employeeEvalAdapter.handle(first, { scenario: ODS_EMPLOYEE_SCENARIO, eventIndex: 0, priorEvents: [] })
    const snapshot = await employeeEvalAdapter.snapshot(ODS_EMPLOYEE_SCENARIO)
    const trace = snapshot.traces.find((x) => x.id === 'ods:onboarding')
    expect(trace?.evaluable).toBe(true)
    expect(trace?.stages.observe?.completed).toBe(true)
    expect(trace?.stages.extract?.completed).toBe(true)
    expect(trace?.stages.classify?.completed).toBe(true)
    expect((await __employeeEvalAdapterTestKit.counts()).business_learning_events).toBeGreaterThan(0)
  })

  it('never performs real external provider sends', async () => {
    await employeeEvalAdapter.reset(ODS_EMPLOYEE_SCENARIO)
    const first = FROZEN_EMPLOYEE_EVENT_STREAMS['ods-construction-end-to-end-v1'][0]
    await employeeEvalAdapter.handle(first, { scenario: ODS_EMPLOYEE_SCENARIO, eventIndex: 0, priorEvents: [] })
    expect(__employeeEvalAdapterTestKit.externalEffects).toEqual([])
  })

  it('makes durable memory, candidate fingerprints, provenance and customer-use state observable', async () => {
    await employeeEvalAdapter.reset(ODS_EMPLOYEE_SCENARIO)
    const first = FROZEN_EMPLOYEE_EVENT_STREAMS['ods-construction-end-to-end-v1'][0]
    await employeeEvalAdapter.handle(first, { scenario: ODS_EMPLOYEE_SCENARIO, eventIndex: 0, priorEvents: [] })
    const snapshot = await employeeEvalAdapter.snapshot(ODS_EMPLOYEE_SCENARIO)
    expect(snapshot.facts.length).toBeGreaterThan(0)
    expect(snapshot.facts.some((fact) => fact.provenance?.ref)).toBe(true)
    expect((await __employeeEvalAdapterTestKit.candidateFingerprints()).length).toBeGreaterThan(0)
    expect(snapshot.retrievals).toEqual(expect.any(Array))
  })

  it('exposes actual supersession state produced by the real conflict resolver', async () => {
    const snapshot = await runEmployeeScenario(ODS_EMPLOYEE_SCENARIO, employeeEvalAdapter)
    const quoteFacts = snapshot.facts.filter((fact) => fact.canonicalKey === 'workspace.quote_fee' && !['candidate','rejected'].includes(fact.state))
    expect(quoteFacts.some((fact) => fact.state === 'superseded' && fact.supersededBy)).toBe(true)
    expect(quoteFacts.filter((fact) => fact.state === 'current')).toHaveLength(1)
  })

  it('exposes opportunity, execution and interruption surfaces without synthesizing missing behavior', async () => {
    const snapshot = await runEmployeeScenario(BIMINI_EMPLOYEE_SCENARIO, employeeEvalAdapter)
    expect(snapshot.opportunities).toEqual(expect.any(Array))
    expect(snapshot.actions).toEqual(expect.any(Array))
    expect(snapshot.notes?.join('\n')).toMatch(/does not synthesize missing behavior/i)
  })

  it('keeps semantic-scope isolation probes visible and evaluable', async () => {
    const snapshot = await runEmployeeScenario(BIMINI_EMPLOYEE_SCENARIO, employeeEvalAdapter)
    const founder = snapshot.traces.find((trace) => trace.id === 'bimini:founder-job-search-probe')
    const engineering = snapshot.traces.find((trace) => trace.id === 'bimini:engineering-fea-probe')
    expect(founder).toMatchObject({ evaluable: true, sourceDomain: 'founder_admin' })
    expect(engineering).toMatchObject({ evaluable: true, sourceDomain: 'engineering_task' })
    expect(snapshot.facts.some((fact) => ['founder_admin','engineering_task'].includes(fact.sourceDomain))).toBe(false)
  })

  it('fails closed when a required trace is unevaluable', () => {
    const snapshot: EmployeeScenarioSnapshot = {
      scenarioId: ODS_EMPLOYEE_SCENARIO.id,
      benchmarkVersion: ODS_EMPLOYEE_SCENARIO.benchmarkVersion,
      workspaceId: ODS_EMPLOYEE_SCENARIO.workspaceId,
      codeRevision: actualSha,
      generatedAt: new Date().toISOString(),
      facts: [], retrievals: [], opportunities: [], actions: [], ledger: { ...ZERO_LEDGER },
      traces: ODS_EMPLOYEE_SCENARIO.requiredTraceIds.map((id) => ({
        id, workspaceId: ODS_EMPLOYEE_SCENARIO.workspaceId, required: true,
        evaluable: id !== 'ods:onboarding', sourceDomain: 'customer_business', stages: {},
      })),
    }
    const report = evaluateEmployeeBenchmark([ODS_EMPLOYEE_SCENARIO], [snapshot], new Date().toISOString())
    expect(report.hardFailures).toContain('required_trace_unevaluable')
  })

  it('cannot substitute the historical frozen baseline for candidate execution', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/caye-employee-eval/production-adapter.ts'), 'utf8')
    expect(source).not.toMatch(/baseline-current-main/)
    expect(source).not.toMatch(/caye-employee-eval\/baselines/)
    expect(source).not.toMatch(/current-main-.*\.summary\.json/)
  })
})
