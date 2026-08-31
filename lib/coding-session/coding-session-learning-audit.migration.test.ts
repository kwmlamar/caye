import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations/20260830q_coding_session_learning_audit.sql'),
  'utf8',
)

describe('coding-session learning audit migration', () => {
  it('feeds only qualifying workspace production outcomes into the existing learning audit', () => {
    expect(sql).toContain('operator_learning_audit')
    expect(sql).toContain("'software_engineering_outcome_learning_v1'")
    expect(sql).toContain("'candidate'")
    expect(sql).toContain("'caye_coding_sessions'")
    expect(sql).toMatch(/if new\.workspace_id is null then\s+return new;/i)
    expect(sql).toMatch(/new\.outcome_environment is distinct from 'production'/i)
    expect(sql).toContain("productionEvidenceSource")
    expect(sql).toContain("'production'")
    expect(sql).toContain("new.execution_evidence = '{}'::jsonb")
    expect(sql).toContain('new.observed_outcome is null')
    expect(sql).toContain('new.prediction_comparison is null')
  })

  it('requires a stable learning key and groups repeated evidence without crossing scope', () => {
    expect(sql).toContain('add column if not exists learning_key text')
    expect(sql).toMatch(/v_key := nullif\(btrim\(new\.learning_key\), ''\)/i)
    expect(sql).toContain('s.workspace_id = new.workspace_id')
    expect(sql).toContain('s.repository_full_name = new.repository_full_name')
    expect(sql).toContain('s.learning_key = v_key')
    expect(sql).toContain('s.engineering_verdict = new.engineering_verdict')
    expect(sql).toMatch(/count\(distinct s\.id\)::integer/i)
  })

  it('keeps one outcome candidate-only and does not auto-promote software memory', () => {
    expect(sql).toContain('when v_matching_count < 2 then')
    expect(sql).toContain('reusable learning requires at least 2')
    expect(sql).toContain('does not auto-promote software lessons')
    expect(sql).not.toContain('write_typed_business_memory_atomic')
    expect(sql).not.toMatch(/insert into public\.business_facts/i)
  })

  it('does not count conflicting verdicts as matching repeated evidence', () => {
    expect(sql).toContain('s.engineering_verdict = new.engineering_verdict')
    expect(sql).toContain("new.engineering_verdict not in ('production_verified', 'failed')")
  })

  it('installs exactly one candidate trigger on canonical coding sessions', () => {
    expect(sql).toContain('create or replace function public.capture_coding_session_learning_audit()')
    expect(sql).toContain('drop trigger if exists coding_session_learning_audit_after_outcome on public.caye_coding_sessions')
    expect(sql).toContain('create trigger coding_session_learning_audit_after_outcome')
    expect(sql).toContain('on public.caye_coding_sessions')
  })
})
