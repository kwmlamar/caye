import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260814163945_caye_authorizations_and_jobs.sql'), 'utf8')

describe('Phase 3 authorization and job schema contract', () => {
  it('keeps all generic links workspace-scoped and history-preserving', () => {
    expect(migration).toContain('create table public.caye_authorizations')
    expect(migration).toContain('create table public.caye_jobs')
    expect(migration).toContain('references public.caye_relationships(workspace_id, id) on delete restrict')
    expect(migration).toContain('references public.caye_work_opportunities(workspace_id, id) on delete restrict')
    expect(migration).toContain('references public.caye_authorizations(workspace_id, id) on delete restrict')
    expect(migration).toContain('alter table public.caye_authorizations enable row level security')
    expect(migration).toContain('alter table public.caye_jobs enable row level security')
    expect(migration).toContain("authorizer_kind in ('workspace_operator', 'external_representative')")
    expect(migration).toContain('authorized_by_contact_id uuid')
    expect(migration).toContain('references public.contacts(customer_id, id) on delete restrict')
  })

  it('defines only the approved work and lifecycle semantics', () => {
    expect(migration).toContain("authority_type in ('one_time', 'standing', 'mandate')")
    expect(migration).toContain("work_type in ('bounded', 'recurring', 'continuous')")
    expect(migration).toContain('job_key text not null')
    expect(migration).toContain("status in ('authorized', 'ready', 'blocked', 'active', 'completed', 'failed', 'cancelled')")
    expect(migration).toContain("'authorization_created'")
    expect(migration).toContain("'job_blocked'")
    expect(migration).toContain("'job_ready'")
  })

  it('allows a prospect contact only through its own explicit inbound proof and never treats acquisition access as prospect access', () => {
    expect(migration).toContain("p_source_type <> 'unified_message'")
    expect(migration).toContain('r.contact_id = p_authorized_by_contact_id')
    expect(migration).toContain("m.sender_type = 'customer'")
    expect(migration).toContain("p_authority_type <> 'one_time'")
    expect(migration).toContain("direct relationship contact replies may authorize only bounded customer inquiry work")
    expect(migration).toContain('v_has_channel := false')
    expect(migration).toContain("'missing_counterparty_communication_access'")
    expect(migration).toContain("'missing_relationship_operating_resource'")
  })
})
