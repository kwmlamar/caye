export type BenchChannel = 'whatsapp' | 'email' | 'caye_direct' | 'system'
export type BenchActorRole = 'customer' | 'operator' | 'owner' | 'staff' | 'caye' | 'system'
export type BenchRisk = 'read' | 'low_write' | 'high_write'
export type BenchOutcome = 'success' | 'failed' | 'uncertain' | 'blocked' | 'noop'

export interface BenchActor {
  id: string
  role: BenchActorRole
  name?: string
}

export interface BenchInputEvent {
  id: string
  at: string
  channel: BenchChannel
  actor: BenchActor
  kind: 'message' | 'correction' | 'timer' | 'provider_result' | 'artifact' | 'state_change'
  text?: string
  data?: Record<string, unknown>
}

export interface BenchEvidence {
  kind: 'tool_result' | 'authoritative_state' | 'operator_instruction' | 'provider_receipt' | 'artifact' | 'policy'
  ref: string
  summary?: string
}

export interface BenchEffect {
  id: string
  workspaceId: string
  at: string
  kind: 'message' | 'tool_call' | 'state_write' | 'escalation' | 'proactive_action' | 'artifact_return'
  channel?: BenchChannel
  risk: BenchRisk
  consequential?: boolean
  authorized?: boolean
  idempotencyKey?: string
  outcome: BenchOutcome
  uncertainty?: 'none' | 'ambiguous'
  claim?: string
  evidence?: BenchEvidence[]
  factKey?: string
  factValue?: string
  operatorInterruption?: boolean
  useful?: boolean
  metadata?: Record<string, unknown>
}

export interface BenchStepContext {
  workspaceId: string
  now: string
  seed: number
  priorEvents: readonly BenchInputEvent[]
  priorEffects: readonly BenchEffect[]
}

export interface BenchAdapter {
  name: string
  handle(event: BenchInputEvent, context: BenchStepContext): Promise<BenchEffect[]> | BenchEffect[]
  /**
   * Optional lifecycle hook, called by `runBenchScenario` once, before the
   * first event, whenever a scenario starts. `ScriptedBenchAdapter` has no
   * state and doesn't need it. A stateful adapter (durable bookings,
   * business facts, artifacts, per-actor conversation history) DOES need
   * it: `runCayeBench` deliberately reuses one adapter instance across
   * every scenario in a batch (so an adapter can amortize expensive setup
   * across a run), and every canonical scenario in `scenarios.ts` shares
   * `workspaceId: 'bench-bimini'` — without a reset hook, a stateful
   * adapter's durable state from one scenario would silently leak into
   * the next one that happens to reuse the same workspace id, and a
   * "cross-workspace-leakage"-shaped bug would actually be a
   * "cross-SCENARIO-leakage" bug hiding one level up from what the hard
   * invariant gate can see. Optional and additive — no existing adapter
   * or test needs to change.
   */
  reset?(scenario: BenchScenario): void | Promise<void>
}

export interface BenchScenarioAssertionContext {
  scenario: BenchScenario
  events: readonly BenchInputEvent[]
  effects: readonly BenchEffect[]
}

export interface BenchScenarioAssertion {
  id: string
  description: string
  check(context: BenchScenarioAssertionContext): boolean | { pass: boolean; detail?: string }
}

export interface BenchScenario {
  id: string
  name: string
  description: string
  workspaceId: string
  initialTime: string
  seed?: number
  tags?: string[]
  events: BenchInputEvent[]
  assertions?: BenchScenarioAssertion[]
}

export type HardInvariantId =
  | 'unauthorized_consequential_action'
  | 'fabricated_action_or_result'
  | 'duplicate_consequential_execution'
  | 'cross_workspace_leakage'
  | 'false_success_after_ambiguous_failure'
  | 'ignored_authoritative_correction'

export interface BenchViolation {
  invariant: HardInvariantId
  effectId?: string
  eventId?: string
  detail: string
  critical: true
}

export interface BenchQualityMetrics {
  operatorInterruptions: number
  unnecessaryOperatorInterruptions: number
  usefulProactiveActions: number
  uselessProactiveActions: number
  completedConsequentialActions: number
  failedConsequentialActions: number
  evidenceBackedClaims: number
  ungroundedClaims: number
  assertionPassRate: number
}

export interface BenchScenarioResult {
  scenarioId: string
  name: string
  adapter: string
  startedAt: string
  finishedAt: string
  eventsProcessed: number
  effects: BenchEffect[]
  violations: BenchViolation[]
  assertions: Array<{ id: string; description: string; pass: boolean; detail?: string }>
  metrics: BenchQualityMetrics
  qualityScore: number
  passed: boolean
}

export interface BenchReport {
  schemaVersion: 1
  generatedAt: string
  adapter: string
  scenarios: BenchScenarioResult[]
  hardInvariantFailures: number
  scenarioPassRate: number
  aggregateQualityScore: number
  passed: boolean
}
