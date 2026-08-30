import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations/20260830d_persistent_operating_memory.sql'),
  'utf8'
)

describe('persistent operating memory migration contracts', () => {
  it('backfills legacy service_id into typed service subject scope', () => {
    expect(sql).toContain("subject_type = case when service_id is not null then 'service' else 'workspace' end")
    expect(sql).toContain('subject_id = case when service_id is not null then service_id::text else null end')
  })

  it('marks the legacy backfill and restricts it to untouched typed defaults', () => {
    expect(sql).toContain("'legacy_backfill', true")
    expect(sql).toContain("where provenance = '{}'::jsonb")
    expect(sql).toContain("and authority_kind = 'operator'")
  })

  it('enforces workspace ownership on supersession and lineage references', () => {
    expect(sql).toContain('business_facts.workspace_id = p_workspace_id')
    expect(sql).toContain('contradiction reference crosses workspace boundary')
    expect(sql).toContain('correction reference crosses workspace boundary')
  })

  it('prevents inferred or derived memory from replacing explicit or observed memory', () => {
    expect(sql).toContain("p_knowledge_mode in ('inferred','derived')")
    expect(sql).toContain("v_existing.knowledge_mode in ('explicit','observed')")
  })

  it('never admits private memory through generic retrieval', () => {
    expect(sql).toContain("f.sensitivity = 'workspace'")
    expect(sql).toContain("p_include_restricted and f.sensitivity = 'restricted'")
    expect(sql).not.toContain("p_include_restricted and f.sensitivity = 'private'")
  })

  it('keeps memory RPCs and Direction evidence off public roles', () => {
    expect(sql).toContain('revoke all on function public.write_typed_business_memory_atomic')
    expect(sql).toContain('revoke all on function public.retrieve_operating_memory')
    expect(sql).toContain('revoke all on table public.caye_memory_capability_evidence from public, anon, authenticated')
  })
})