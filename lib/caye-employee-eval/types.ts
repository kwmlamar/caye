export const CAYE_EMPLOYEE_BENCHMARK_VERSION = 'caye-employee-eval/1.0.0' as const

export type EmployeeDimension =
  | 'onboarding_learning'
  | 'continuous_learning'
  | 'memory_correctness'
  | 'contradiction_handling'
  | 'provenance_authority'
  | 'retrieval_quality'
  | 'proactive_opportunity_detection'
  | 'economic_relevance'
  | 'autonomous_execution'
  | 'human_interruption_quality'
  | 'task_completion'
  | 'workspace_context_isolation'
  | 'temporal_reasoning'
  | 'failure_recovery'
  | 'observability'

export type LearningStage = 'observe' | 'extract' | 'classify' | 'resolve' | 'store' | 'retrieve' | 'act' | 'correct'
export type AuthorityKind = 'owner' | 'operator' | 'staff' | 'customer' | 'system' | 'founder' | 'inferred' | 'unknown'
export type SourceDomain = 'customer_business' | 'customer_operator' | 'founder_admin' | 'platform_test' | 'engineering_task' | 'personal_direct_task' | 'system_internal'
export type FactState = 'current' | 'superseded' | 'candidate' | 'rejected'
export type AuthorizationClass = 'standing_authority' | 'owner_required' | 'missing_capability' | 'read_only'

export interface ProvenanceObservation {
  type: string
  source: string
  ref?: string
  observedAt?: string
}

export interface DurableFactObservation {
  id: string
  workspaceId: string
  memoryType?: string | null
  canonicalKey?: string | null
  value: string
  authority?: AuthorityKind | null
  confidence?: number | null
  provenance?: ProvenanceObservation | null
  validFrom?: string | null
  validTo?: string | null
  state: FactState
  retrievable: boolean
  customerFacingEligible: boolean
  consequential?: boolean
  sourceDomain: SourceDomain
  supersededBy?: string | null
  correctionOf?: string | null
}

export interface RetrievalObservation {
  id: string
  workspaceId: string
  canonicalKey?: string | null
  factId?: string | null
  value: string
  current: boolean
  customerFacingUse: boolean
  evidenceRefs: string[]
  sourceDomain: SourceDomain
  at: string
}

export interface OpportunityObservation {
  id: string
  workspaceId: string
  opportunityType: string
  economicObjective: 'save_time' | 'reduce_wait' | 'protect_revenue' | 'create_revenue' | 'reduce_risk'
  evidenceRefs: string[]
  confidence?: number | null
  dedupeIdentity?: string | null
  authorizationClass: AuthorizationClass
  autonomousWork: string[]
  humanInterruption: boolean
  finalState: string
  sourceDomain: SourceDomain
  outcome: Partial<EconomicLedger>
}

export interface ActionObservation {
  id: string
  workspaceId: string
  kind: string
  consequential: boolean
  authorized: boolean
  autonomous: boolean
  eligibleForAutonomy: boolean
  completed: boolean
  externalSuccessClaimed: boolean
  externalResultVerified: boolean
  evidenceRefs: string[]
  humanInterruption: boolean
  interruptionNecessary?: boolean
  recoverable?: boolean
  failureVisible?: boolean
  sourceDomain: SourceDomain
}

export interface LearningTraceObservation {
  id: string
  workspaceId: string
  required: boolean
  evaluable: boolean
  sourceDomain: SourceDomain
  stages: Partial<Record<LearningStage, { completed: boolean; evidenceRefs: string[] }>>
}

export interface EconomicLedger {
  owner_minutes_saved: number
  customer_wait_minutes_avoided: number
  revenue_at_risk: number
  revenue_protected: number
  revenue_created: number
  human_interruptions: number
  unnecessary_interruptions: number
  actions_completed_autonomously: number
  eligible_actions_not_completed: number
  duplicate_opportunities: number
  stale_or_wrong_facts_used: number
}

export interface FactExpectation {
  id: string
  checkpoint: string
  shouldExist: boolean
  memoryType?: string
  canonicalKey: string
  valueIncludes?: string[]
  authority?: AuthorityKind
  confidence?: { min: number; max: number }
  provenanceType?: string
  source?: string
  validAt?: string
  state?: 'current' | 'superseded'
  retrievable?: boolean
  customerFacingEligible?: boolean
  consequential?: boolean
}

export interface OpportunityExpectation {
  id: string
  opportunityType: string
  economicObjective: OpportunityObservation['economicObjective']
  evidenceMin: number
  confidence?: { min: number; max: number }
  dedupeIdentity: string
  authorizationClass: AuthorizationClass
  expectedAutonomousWork: string[]
  expectedHumanInterruption: boolean
  finalState: string
  measurableOutcome: Partial<EconomicLedger>
}

export interface EmployeeScenarioFixture {
  id: string
  name: string
  benchmarkVersion: typeof CAYE_EMPLOYEE_BENCHMARK_VERSION
  workspaceId: string
  businessName: string
  description: string
  requiredTraceIds: string[]
  expectedFacts: FactExpectation[]
  expectedOpportunities: OpportunityExpectation[]
  expectedLedgerMinimums: Partial<EconomicLedger>
  forbiddenSourceDomains: SourceDomain[]
}

export interface EmployeeScenarioSnapshot {
  scenarioId: string
  benchmarkVersion: string
  workspaceId: string
  codeRevision: string
  generatedAt: string
  skipped?: boolean
  facts: DurableFactObservation[]
  retrievals: RetrievalObservation[]
  opportunities: OpportunityObservation[]
  actions: ActionObservation[]
  traces: LearningTraceObservation[]
  ledger: EconomicLedger
  notes?: string[]
}

export type HardFailureId =
  | 'cross_workspace_leakage'
  | 'founder_platform_test_contamination'
  | 'unauthorized_consequential_execution'
  | 'fabricated_external_success'
  | 'authoritative_correction_ignored'
  | 'consequential_current_fact_missing_provenance'
  | 'stale_superseded_fact_used_as_current'
  | 'benchmark_scenario_silently_skipped'
  | 'required_trace_unevaluable'

export interface EvalAssertionResult {
  id: string
  subsystem: string
  dimension: EmployeeDimension
  pass: boolean
  detail: string
  hardFailure?: HardFailureId
}

export interface DimensionScore {
  dimension: EmployeeDimension
  score: number
  passed: boolean
  standard: string
  numerator: number
  denominator: number
  failingAssertionIds: string[]
}

export interface EmployeeScenarioResult {
  scenarioId: string
  assertions: EvalAssertionResult[]
  dimensions: DimensionScore[]
  hardFailures: HardFailureId[]
  ledger: EconomicLedger
  passed: boolean
}

export interface EmployeeEvalReport {
  schemaVersion: 1
  benchmarkVersion: typeof CAYE_EMPLOYEE_BENCHMARK_VERSION
  codeRevision: string
  generatedAt: string
  scenarios: EmployeeScenarioResult[]
  dimensions: DimensionScore[]
  hardFailures: HardFailureId[]
  aggregateScore: number
  passed: boolean
  failuresBySubsystem: Record<string, EvalAssertionResult[]>
}

export interface EmployeeEvalDiff {
  benchmarkVersion: string
  baselineRevision: string
  candidateRevision: string
  comparable: boolean
  aggregateDelta: number
  dimensionDeltas: Array<{ dimension: EmployeeDimension; baseline: number; candidate: number; delta: number }>
  newHardFailures: HardFailureId[]
  fixedHardFailures: HardFailureId[]
}

export const ZERO_LEDGER: EconomicLedger = {
  owner_minutes_saved: 0,
  customer_wait_minutes_avoided: 0,
  revenue_at_risk: 0,
  revenue_protected: 0,
  revenue_created: 0,
  human_interruptions: 0,
  unnecessary_interruptions: 0,
  actions_completed_autonomously: 0,
  eligible_actions_not_completed: 0,
  duplicate_opportunities: 0,
  stale_or_wrong_facts_used: 0,
}
