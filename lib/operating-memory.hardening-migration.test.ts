import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations/20260830_memory_privilege_and_lineage_index_hardening.sql'),
  'utf8'
)

describe('persistent operating memory hardening migration contracts', () => {
  it('removes direct client-role access from the durable memory table', () => {
    expect(sql).toContain('revoke all on table public.business_facts from anon, authenticated')
    expect(sql).toContain('grant all on table public.business_facts to service_role')
  })

  it('indexes supersession and correction lineage foreign keys', () => {
    expect(sql).toContain('business_facts_superseded_by_idx')
    expect(sql).toContain('on public.business_facts (superseded_by)')
    expect(sql).toContain('business_facts_contradicts_fact_id_idx')
    expect(sql).toContain('on public.business_facts (contradicts_fact_id)')
    expect(sql).toContain('business_facts_correction_of_fact_id_idx')
    expect(sql).toContain('on public.business_facts (correction_of_fact_id)')
  })

  it('adds an FK-covering service_id index without replacing workspace retrieval indexes', () => {
    expect(sql).toContain('business_facts_service_id_fk_idx')
    expect(sql).toContain('on public.business_facts (service_id)')
    expect(sql).not.toContain('drop index')
  })
})
