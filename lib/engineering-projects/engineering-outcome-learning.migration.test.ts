import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations/20260830m_engineering_outcome_learning.sql'),
  'utf8',
)

describe('engineering outcome learning migration contracts', () => {
  it('never learns from inconclusive or unverified execution', () => {
    expect(sql).toMatch(/if new\.verdict = 'inconclusive' then\s+return new;/i)
    expect(sql).toContain('engineering_project_execution_evidence')
    expect(sql).toContain('engineering_project_outcomes')
    expect(sql).toMatch(/if not exists[\s\S]*engineering_project_execution_evidence[\s\S]*or not exists[\s\S]*engineering_project_outcomes/i)
  })

  it('records evidence-backed verdicts as candidates before validation', () => {
    expect(sql).toContain('operator_learning_audit')
    expect(sql).toContain("'engineering_outcome_learning_v2'")
    expect(sql).toContain("'inferred_from_action'")
    expect(sql).toContain("'candidate'")
    expect(sql).toContain("'engineering_project_verdicts'")
    expect(sql).toContain('new.id::text')
  })

  it('requires two independent verified projects before reusable memory is written', () => {
    expect(sql).toMatch(/count\(distinct v\.project_id\)::integer/i)
    expect(sql).toContain('if v_evidence_count < 2 then')
    expect(sql).toContain("'minimum_evidence_threshold', 2")
    expect(sql).toContain("'evidence_count', v_evidence_count")
    expect(sql).toContain("'contributing_project_ids', v_contributing_projects")
  })

  it('writes only validated derived property-scoped outcome memory', () => {
    expect(sql).toContain("p_memory_type := 'outcome'")
    expect(sql).toContain("p_subject_type := 'property'")
    expect(sql).toContain("p_knowledge_mode := 'derived'")
    expect(sql).toContain("p_authority_kind := 'system'")
    expect(sql).toContain("p_source := 'system-derived'")
    expect(sql).toContain("p_created_by := 'engineering_verdict_learning_v2'")
    expect(sql).toContain("'kind', 'engineering_project_verdict_pattern'")
  })

  it('keeps one active derived engineering lesson per property and preserves supersession history', () => {
    expect(sql).toContain("v_canonical_key := 'engineering_outcome:property:' || v_property_id::text")
    expect(sql).toContain("f.knowledge_mode = 'derived'")
    expect(sql).toContain("f.authority_kind = 'system'")
    expect(sql).toContain('p_supersede_id := v_prior_memory_id')
    expect(sql).toContain("case when v_prior_memory_id is null then 'written' else 'superseded_and_written' end")
    expect(sql).toContain('superseded_record_id')
  })

  it('does not silently claim human or observed authority', () => {
    expect(sql).not.toContain("p_knowledge_mode := 'observed'")
    expect(sql).not.toContain("p_authority_kind := 'owner'")
    expect(sql).not.toContain("p_source := 'owner-direct'")
  })

  it('returns only validated lessons to later engineering reasoning', () => {
    expect(sql).toContain('create or replace function public.retrieve_engineering_outcome_memory')
    expect(sql).toContain("array['outcome']::text[]")
    expect(sql).toContain("m.knowledge_mode = 'derived'")
    expect(sql).toContain("m.authority_kind = 'system'")
    expect(sql).toMatch(/evidence_count[\s\S]*minimum_evidence_threshold/i)
    expect(sql).toContain('Use this as evidence when making later engineering recommendations')
    expect(sql).toMatch(/revoke all on function public\.retrieve_engineering_outcome_memory\(uuid, uuid, integer\) from public, anon, authenticated;/i)
    expect(sql).toMatch(/grant execute on function public\.retrieve_engineering_outcome_memory\(uuid, uuid, integer\) to service_role;/i)
  })
})
