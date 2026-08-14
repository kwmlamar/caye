import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260814155525_caye_relationships_and_work_opportunities.sql'), 'utf8')

describe('relationship and opportunity schema contract', () => {
  it('makes contact, relationship, opportunity, and evidence links workspace-scoped', () => {
    expect(migration).toContain('foreign key (workspace_id, contact_id)')
    expect(migration).toContain('references public.contacts(customer_id, id)')
    expect(migration).toContain('foreign key (workspace_id, relationship_id)')
    expect(migration).toContain('references public.caye_relationships(workspace_id, id)')
    expect(migration).toContain('foreign key (workspace_id, opportunity_id)')
    expect(migration).toContain('references public.caye_work_opportunities(workspace_id, id)')
    expect(migration).toContain('on delete set null (contact_id)')
    expect(migration).toContain('references public.caye_relationships(workspace_id, id) on delete restrict')
    expect(migration).toContain('references public.caye_work_opportunities(workspace_id, id) on delete restrict')
  })

  it('requires evidence and preserves replay-safe deduplication in the RPC seam', () => {
    expect(migration).toContain('unique (opportunity_id, source_type, source_id)')
    expect(migration).toContain('on conflict (opportunity_id, source_type, source_id) do nothing')
    expect(migration).toContain("check (confidence in ('medium', 'high'))")
    expect(migration).toContain('caye_work_opportunity_evidence_immutable')
    expect(migration).toContain('work opportunity evidence is immutable')
    expect(migration).toContain("'work_opportunity_created'")
    expect(migration).toContain("'work_opportunity_materially_updated'")
  })
})
