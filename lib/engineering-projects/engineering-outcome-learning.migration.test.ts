import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations/20260830m_engineering_outcome_learning.sql'),
  'utf8',
)

describe('engineering outcome learning migration contracts', () => {
  it('never promotes inconclusive verdicts into durable learning', () => {
    expect(sql).toMatch(/if new\.verdict = 'inconclusive' then\s+return new;/i)
  })

  it('requires both execution evidence and linked outcome evidence', () => {
    expect(sql).toContain('engineering_project_execution_evidence')
    expect(sql).toContain('engineering_project_outcomes')
    expect(sql).toMatch(/if not exists[\s\S]*engineering_project_execution_evidence[\s\S]*or not exists[\s\S]*engineering_project_outcomes/i)
  })

  it('writes only derived property-scoped outcome memory with structured provenance', () => {
    expect(sql).toContain("p_memory_type := 'outcome'")
    expect(sql).toContain("p_subject_type := 'property'")
    expect(sql).toContain("p_knowledge_mode := 'derived'")
    expect(sql).toContain("p_authority_kind := 'system'")
    expect(sql).toContain("'kind', 'engineering_project_verdict'")
    expect(sql).toContain("'source_message_id', new.source_message_id")
  })

  it('supersedes only the prior derived system lesson for the same project and property', () => {
    expect(sql).toContain("f.canonical_key = 'engineering_outcome:project:' || new.project_id::text")
    expect(sql).toContain("f.subject_type = 'property'")
    expect(sql).toContain("f.memory_type = 'outcome'")
    expect(sql).toContain("f.knowledge_mode = 'derived'")
    expect(sql).toContain("f.authority_kind = 'system'")
    expect(sql).toContain('p_supersede_id := v_prior_memory_id')
  })

  it('exposes a service-role-only, property-scoped read path for later engineering decisions', () => {
    expect(sql).toContain('create or replace function public.retrieve_engineering_outcome_memory')
    expect(sql).toContain("array['outcome']::text[]")
    expect(sql).toContain("'property'")
    expect(sql).toContain('p_property_id::text')
    expect(sql).toMatch(/revoke all on function public\.retrieve_engineering_outcome_memory\(uuid, uuid, integer\) from public, anon, authenticated;/i)
    expect(sql).toMatch(/grant execute on function public\.retrieve_engineering_outcome_memory\(uuid, uuid, integer\) to service_role;/i)
  })
})
