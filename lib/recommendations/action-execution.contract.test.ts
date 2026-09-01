import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const runtime = read('lib/recommendations/action-runtime-production.ts')
const operation = read('lib/recommendations/action-operation.ts')
const worker = read('lib/pending-operations-worker.ts')
const plan = read('lib/recommendations/action-plan.ts')
const planProduction = read('lib/recommendations/action-plan-production.ts')
const versionMigration = read('supabase/migrations/20260901022000_recommendation_action_plan_version.sql')

describe('canonical recommendation execution bridge contract', () => {
  it('reloads scope, version, decision and fails stale/cross-workspace execution closed', () => {
    expect(runtime).toMatch(/\.eq\('workspace_id', input\.workspaceId\)/)
    expect(runtime).toMatch(/version !== input\.recommendationVersion/)
    expect(runtime).toMatch(/decision\.id !== input\.decisionId/)
    expect(runtime).toMatch(/decision\.recommendation_version !== input\.recommendationVersion/)
    expect(operation).toMatch(/recommendation_version_changed/)
    expect(operation).toMatch(/recommendation_decision_changed/)
  })

  it('revalidates current authority immediately through the canonical recommendation decision lifecycle', () => {
    expect(runtime).toMatch(/currentAuthority/)
    expect(runtime).toMatch(/decideRecommendationForExecution/)
    expect(runtime).toMatch(/acceptedDecision/)
    expect(runtime).toMatch(/current recommendation authority blocks execution/)
  })

  it('an accepted decision alone cannot bypass execution-time checks', () => {
    const decisionCheck = runtime.indexOf("decision.decision !== 'accepted'")
    const authorityCheck = runtime.indexOf('decideRecommendationForExecution({')
    const toolResolution = runtime.indexOf('toolForRecommendationPlan(plan)')
    expect(decisionCheck).toBeGreaterThan(-1)
    expect(authorityCheck).toBeGreaterThan(decisionCheck)
    expect(toolResolution).toBeGreaterThan(authorityCheck)
  })

  it('selects executable behavior only from the persisted structured plan and registered tool registry', () => {
    expect(runtime).toMatch(/validateRecommendationActionPlan\(provenance\.actionPlan\)/)
    expect(runtime).toMatch(/toolForRecommendationPlan\(plan\)/)
    expect(runtime).toMatch(/runToolWithRecovery\(tool, plan\.arguments/)
    expect(plan).toMatch(/findTool\(raw\.capabilityKey\.trim\(\)\)/)
    expect(plan).not.toMatch(/eval\(|child_process|execSync|spawn\(/)
  })

  it('never uses free-form recommendation prose to select the execution capability', () => {
    expect(runtime).not.toMatch(/rec\.recommendation|rec\.rationale|recommendation\.recommendation|recommendation\.rationale/)
    expect(planProduction).toMatch(/actionPlanFingerprint/)
    expect(versionMigration).toMatch(/provenance->'actionPlan'/)
    expect(versionMigration).toMatch(/actionPlanFingerprint/)
  })

  it('reuses the existing durable pending-operation claim/idempotency path and records terminal failure', () => {
    expect(worker).toMatch(/claimDueOperations/)
    expect(worker).toMatch(/markSynced/)
    expect(worker).toMatch(/markAttemptFailed/)
    expect(operation).toMatch(/row\.idempotency_key/)
    expect(operation).toMatch(/failed_needs_attention/)
    expect(runtime).toMatch(/recommendationExecutionError/)
  })

  it('feeds the durable execution row into recommendation outcome learning only after sync', () => {
    const mark = worker.indexOf('await markSynced(row)')
    const record = worker.indexOf('recordRecommendationExecutionOutcome(row, result.executionRef)')
    expect(mark).toBeGreaterThan(-1)
    expect(record).toBeGreaterThan(mark)
    expect(worker).toMatch(/recordExecutedRecommendationAction/)
    expect(worker).toMatch(/executionSourceTable: 'caye_pending_operations'/)
    expect(worker).toMatch(/executionSourceId: row\.id/)
  })

  it('preserves founder/autonomous actor and authority provenance in the outcome handoff', () => {
    expect(worker).toMatch(/decisionActorKind: decision\.actor_kind/)
    expect(worker).toMatch(/authorityProvenance: decision\.authority_provenance/)
  })
})
