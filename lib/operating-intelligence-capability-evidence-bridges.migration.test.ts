import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  path.resolve(
    process.cwd(),
    'supabase/migrations/20260902150000_operating_intelligence_capability_evidence_bridges.sql'
  ),
  'utf8'
)

describe('operating intelligence capability evidence bridges migration', () => {
  it('publishes evidence for exactly the four evaluated capabilities, and nothing else', () => {
    expect(sql).toContain("capability_key = 'research_intelligence'")
    expect(sql).toContain("capability_key = 'engineering_copilot'")
    expect(sql).toContain("capability_key = 'human_command_interface'")
    expect(sql).toContain("capability_key = 'memory_context'")
    // Skipped candidates and every other roadmap capability must not gain a bridge here.
    expect(sql).not.toContain("capability_key = 'reasoning_simulation'")
    expect(sql).not.toContain("capability_key = 'planning_anticipation'")
    expect(sql).not.toContain("capability_key = 'proactive_operator'")
    expect(sql).not.toContain("capability_key = 'adaptive_learning'")
    expect(sql).not.toContain("capability_key = 'monitoring_control'")
    expect(sql).not.toContain("capability_key = 'execution_autonomy'")
    expect(sql).not.toContain("capability_key = 'perception_awareness'")
    expect(sql).not.toContain("capability_key = 'environment_machine_interface'")
  })

  it('never sets maturity_status or progress_percent from a bridge', () => {
    expect(sql).not.toContain('maturity_status')
    expect(sql).not.toContain('progress_percent')
    expect(sql).not.toContain('progress_evidence_id')
  })

  it('never touches the progress-evidence guard trigger or its constraint', () => {
    expect(sql).not.toContain('enforce_caye_oi_capability_progress_evidence')
    expect(sql).not.toContain('caye_oi_capabilities_progress_pair')
    expect(sql).not.toContain('drop constraint')
    expect(sql).not.toContain('drop trigger if exists caye_oi_capabilities_progress_guard')
  })

  it('only ever inserts verifies_capability = true, never false, matching the completed-outcome gates', () => {
    expect(sql).not.toContain('verifies_capability, false')
    expect(sql).not.toContain('verifies_capability = false')
    const trueInsertCount = (sql.match(/true,\n\s*1,/g) ?? []).length
    expect(trueInsertCount).toBe(4)
  })

  it('gates research evidence on an actually completed run with a completion timestamp', () => {
    expect(sql).toContain("new.status <> 'completed' or new.completed_at is null")
    expect(sql).toContain("'research_run:' || new.id::text")
  })

  it('gates engineering copilot evidence on a pushed session with real passing gates, not merely code existing', () => {
    expect(sql).toContain("new.status <> 'pushed'")
    expect(sql).toContain("coalesce(new.engineering_verdict, '') not in ('branch_verified', 'production_verified')")
    expect(sql).toContain('new.gate_test_passed is not true')
    expect(sql).toContain('new.gate_build_passed is not true')
    expect(sql).toContain('new.work_branch is null')
    expect(sql).toContain('new.final_commit_sha is null')
    expect(sql).toContain("'coding_session:' || new.id::text")
  })

  it('gates human command interface evidence on an actually completed Caye Direct run', () => {
    expect(sql).toContain("new.status <> 'completed' or new.completed_at is null")
    expect(sql).toContain("'caye_direct_run:' || new.id::text")
  })

  it('gates memory context evidence on a decision that actually wrote a durable target record, not a candidate or no-op', () => {
    expect(sql).toContain("new.decision not in ('written', 'superseded_and_written')")
    expect(sql).toContain('new.target_table is null')
    expect(sql).toContain('new.target_record_id is null')
    expect(sql).toContain("'operator_learning_audit:' || new.id::text")
  })

  it('is idempotent via the same conflict target as the existing perception bridge', () => {
    const onConflictCount = (
      sql.match(/on conflict \(capability_id, evidence_kind, source_ref\)/g) ?? []
    ).length
    expect(onConflictCount).toBe(4)
    const doUpdateCount = (sql.match(/do update set/g) ?? []).length
    expect(doUpdateCount).toBe(4)
  })

  it('fails closed when a canonical capability row is missing, for all four bridges', () => {
    expect(sql).toContain("raise exception 'canonical Research & Intelligence capability is missing'")
    expect(sql).toContain("raise exception 'canonical Engineering Copilot capability is missing'")
    expect(sql).toContain("raise exception 'canonical Human Command Interface capability is missing'")
    expect(sql).toContain("raise exception 'canonical Memory & Context capability is missing'")
  })

  it('locks every publisher function to service_role only, matching the existing bridge', () => {
    const revokeCount = (
      sql.match(/revoke execute on function public\.publish_\w+_direction_evidence\(\) from public, anon, authenticated;/g) ?? []
    ).length
    const grantCount = (
      sql.match(/grant execute on function public\.publish_\w+_direction_evidence\(\) to service_role;/g) ?? []
    ).length
    expect(revokeCount).toBe(4)
    expect(grantCount).toBe(4)
    // No new client-facing grants or RLS policies are introduced by this migration.
    expect(sql).not.toContain('to authenticated')
    expect(sql).not.toContain('to anon')
    expect(sql).not.toContain('create policy')
  })

  it('adds no new tables — only trigger functions and triggers on already service-role-only tables', () => {
    expect(sql).not.toContain('create table')
    expect(sql).not.toContain('alter table public.research_runs enable row level security')
    expect(sql).not.toContain('alter table public.caye_coding_sessions enable row level security')
    expect(sql).not.toContain('alter table public.caye_direct_runs enable row level security')
    expect(sql).not.toContain('alter table public.operator_learning_audit enable row level security')
  })
})
