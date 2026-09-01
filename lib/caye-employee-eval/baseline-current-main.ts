import { CAYE_EMPLOYEE_BENCHMARK_VERSION, ZERO_LEDGER, type EmployeeScenarioSnapshot, type LearningTraceObservation } from './types'
import { ODS_EMPLOYEE_SCENARIO, BIMINI_EMPLOYEE_SCENARIO } from './fixtures'

export const CURRENT_MAIN_BASELINE_REVISION = 'eda98a4547a20ed2c8ccd75d58fec662c1ceffeb'
export const CURRENT_MAIN_BASELINE_OBSERVED_AT = '2026-09-01T17:00:00-04:00'

function unevaluableTraces(workspaceId: string, ids: readonly string[]): LearningTraceObservation[] {
  return ids.map((id) => ({
    id,
    workspaceId,
    required: true,
    evaluable: false,
    sourceDomain: id.includes('founder') ? 'founder_admin' : id.includes('engineering') ? 'engineering_task' : id.includes('scan') ? 'system_internal' : id.includes('correction') ? 'customer_operator' : 'customer_business',
    stages: {},
  }))
}

/**
 * Frozen observation of CURRENT MAIN before the employee-eval implementation.
 * Source evidence was read-only production inspection. This is deliberately
 * not upgraded into synthetic "success" just because the benchmark knows what
 * Caye should have done.
 */
export const CURRENT_MAIN_BASELINE_SNAPSHOTS: readonly EmployeeScenarioSnapshot[] = [
  {
    scenarioId: ODS_EMPLOYEE_SCENARIO.id,
    benchmarkVersion: CAYE_EMPLOYEE_BENCHMARK_VERSION,
    workspaceId: ODS_EMPLOYEE_SCENARIO.workspaceId,
    codeRevision: CURRENT_MAIN_BASELINE_REVISION,
    generatedAt: CURRENT_MAIN_BASELINE_OBSERVED_AT,
    facts: [],
    retrievals: [],
    opportunities: [],
    actions: [],
    traces: unevaluableTraces(ODS_EMPLOYEE_SCENARIO.workspaceId, ODS_EMPLOYEE_SCENARIO.requiredTraceIds),
    ledger: { ...ZERO_LEDGER },
    notes: [
      'Read-only production inspection: business_facts=0, business_fact_candidates=0, caye_work_opportunities=0.',
      'workspace_ai_config contains authoritative ODS onboarding, but that onboarding is absent from durable business_facts/candidates.',
      'Current main has no production-path EmployeeEvalAdapter capable of replaying the frozen ODS trace in isolated state, so every required trace is marked unevaluable rather than silently credited.',
    ],
  },
  {
    scenarioId: BIMINI_EMPLOYEE_SCENARIO.id,
    benchmarkVersion: CAYE_EMPLOYEE_BENCHMARK_VERSION,
    workspaceId: BIMINI_EMPLOYEE_SCENARIO.workspaceId,
    codeRevision: CURRENT_MAIN_BASELINE_REVISION,
    generatedAt: CURRENT_MAIN_BASELINE_OBSERVED_AT,
    facts: [
      {
        id: 'bc542b90-af9c-45e9-83ca-459db2bf38df',
        workspaceId: BIMINI_EMPLOYEE_SCENARIO.workspaceId,
        memoryType: 'fact',
        canonicalKey: null,
        value: 'The meeting point for the Heritage Tour is the pink building by the dock.',
        authority: 'owner',
        confidence: 1,
        provenance: { type: 'legacy_backfill', source: 'owner-direct', ref: 'business_facts:bc542b90-af9c-45e9-83ca-459db2bf38df' },
        validFrom: '2026-08-30T08:36:39.565704+00:00',
        validTo: null,
        state: 'current',
        retrievable: true,
        customerFacingEligible: true,
        consequential: true,
        sourceDomain: 'customer_business',
      },
      {
        id: 'ab9dac14-fca9-4e98-be44-f91001608ed1',
        workspaceId: BIMINI_EMPLOYEE_SCENARIO.workspaceId,
        memoryType: 'fact',
        canonicalKey: null,
        value: 'The pickup location for all tours is the Casino Tram Stop. Guests can take the free tram to get there.',
        authority: 'owner',
        confidence: 1,
        provenance: { type: 'legacy_backfill', source: 'owner-direct', ref: 'business_facts:ab9dac14-fca9-4e98-be44-f91001608ed1' },
        validFrom: '2026-08-30T08:36:39.565704+00:00',
        validTo: null,
        state: 'current',
        retrievable: true,
        customerFacingEligible: true,
        consequential: true,
        sourceDomain: 'customer_business',
      },
      {
        id: 'db461bfa-caf8-4681-be6d-8e2194cf8c7f',
        workspaceId: BIMINI_EMPLOYEE_SCENARIO.workspaceId,
        memoryType: 'fact',
        canonicalKey: null,
        value: 'North Bimini Heritage Tour shared tours have a minimum of 2 guests and a maximum of 12 guests per vehicle.',
        authority: 'owner',
        confidence: 1,
        provenance: { type: 'legacy_backfill', source: 'owner-direct', ref: 'business_facts:db461bfa-caf8-4681-be6d-8e2194cf8c7f' },
        validFrom: '2026-08-30T08:36:39.565704+00:00',
        validTo: null,
        state: 'current',
        retrievable: true,
        customerFacingEligible: true,
        consequential: true,
        sourceDomain: 'customer_business',
      },
    ],
    retrievals: [],
    opportunities: [],
    actions: [],
    traces: unevaluableTraces(BIMINI_EMPLOYEE_SCENARIO.workspaceId, BIMINI_EMPLOYEE_SCENARIO.requiredTraceIds),
    ledger: { ...ZERO_LEDGER },
    notes: [
      'Read-only production inspection: business_facts=28, business_fact_candidates=17, caye_work_opportunities=0.',
      'Both the old pink-building pickup fact and the newer Casino Tram Stop fact are unsuperseded current rows.',
      'The relevant legacy facts have canonical_key=NULL, so the evaluator does not pretend canonical contradiction resolution exists.',
      'Current main has no production-path EmployeeEvalAdapter for this frozen end-to-end trace; required replay traces are marked unevaluable.',
    ],
  },
]
