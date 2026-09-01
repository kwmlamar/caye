import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260901013000_durable_recommendation_decision_lifecycle.sql'), 'utf8')
const service = readFileSync(join(process.cwd(), 'lib', 'recommendations', 'decisions.ts'), 'utf8')

describe('durable recommendation decision lifecycle contracts', () => {
  it('supports pending, founder acceptance, rejection, defer, and cancellation without adding execution state', () => {
    expect(migration).toMatch(/decision in \('pending','accepted','rejected','deferred','cancelled'\)/i)
    expect(migration).toMatch(/p_decision <> 'pending'/i)
    expect(service).toMatch(/actorKind: 'founder' \| 'operator'/)
    expect(service).toMatch(/'accepted' \| 'rejected' \| 'deferred' \| 'cancelled'/)
    expect(migration).not.toMatch(/execution_status|execution_state|executed_at|tool_call_id/i)
  })

  it('snapshots risk and a strict recommendation version at decision time', () => {
    expect(migration).toMatch(/risk_at_decision text/i)
    expect(migration).toMatch(/recommendation_version text/i)
    expect(migration).toMatch(/r\.reversibility/i)
    expect(migration).toMatch(/r\.risk_classification/i)
    expect(migration).toMatch(/r\.required_authority::text/i)
    expect(migration).toMatch(/v_rec\.risk_classification[\s\S]*v_version/i)
  })

  it('cannot reuse stale approval after decision-relevant recommendation fields change', () => {
    expect(migration).toMatch(/v_decision\.recommendation_fingerprint = v_rec\.fingerprint/i)
    expect(migration).toMatch(/v_decision\.recommendation_version = v_version/i)
    expect(migration).toMatch(/v_rec\.status in \('superseded','withdrawn'\)/i)
    expect(migration).toMatch(/stale recommendation cannot be accepted/i)
  })

  it('keeps duplicate decision attempts convergent and auditable', () => {
    expect(migration).toMatch(/caye-recommendation-decision-v2/i)
    expect(migration).toMatch(/p_idempotency_key/i)
    expect(migration).toMatch(/on conflict \(fingerprint\) do update/i)
    expect(migration).toMatch(/actor_kind/i)
    expect(migration).toMatch(/actor_id/i)
    expect(migration).toMatch(/btrim\(p_rationale\)/i)
    expect(migration).toMatch(/authority_provenance/i)
    expect(migration).toMatch(/risk_at_decision/i)
  })

  it('fails closed across workspaces', () => {
    expect(migration).toMatch(/v_rec\.workspace_id is distinct from p_workspace_id/i)
    expect(migration).toMatch(/recommendation decision workspace mismatch/i)
    expect(migration).toMatch(/if v_rec\.workspace_id is distinct from p_workspace_id then return false/i)
    expect(service).toMatch(/recommendation_workspace_mismatch/)
  })

  it('reuses canonical authority, deterministic autonomy, and owner-attention primitives', () => {
    expect(service).toMatch(/decideActionAutonomy/)
    expect(service).toMatch(/resolveWorkspaceDecisionAuthority/)
    expect(service).toMatch(/observeAttentionItem/)
    expect(service).toMatch(/subjectType: 'recommendation_decision'/)
    expect(service).toMatch(/blockedOnOperator: true/)
    expect(service).toMatch(/resolvableAutonomously: false/)
  })

  it('makes Agent 3 call one explicit decision-to-eligibility entry point', () => {
    expect(service).toMatch(/export async function decideRecommendationForExecution/)
    expect(service).toMatch(/executionEligible: true/)
    expect(service).toMatch(/Existing action\/tool gates still[\s\S]*own execution/i)
  })

  it('forces authority-system self-modification through founder judgment', () => {
    expect(service).toMatch(/actionKind === 'authority_policy_change'/)
    expect(service).toMatch(/authority_system_self_modification/)
    expect(service).toMatch(/FOUNDER_ONLY_ACTIONS/)
  })
})
