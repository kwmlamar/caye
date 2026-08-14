import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260814180000_caye_commercial_engagements_and_relationship_resources.sql'), 'utf8')

describe('Phase 4A commercial and resource schema', () => {
  it('keeps commercial proof separate from Sales and protects duplicate source events', () => {
    expect(migration).toContain('create table public.caye_commercial_engagements')
    expect(migration).toContain("unique (workspace_id, source_system, source_id)")
    expect(migration).toContain("relationship_state = 'client'")
    expect(migration).not.toContain("outreach_leads set stage = 'won'")
  })

  it('requires verified, relationship-scoped operating resources rather than borrowing a workspace account', () => {
    expect(migration).toContain('create table public.caye_relationship_operating_workspaces')
    expect(migration).toContain('create table public.caye_relationship_resources')
    expect(migration).toContain('references public.connected_accounts(user_id, id)')
    expect(migration).toContain('foreign key (workspace_id, relationship_id, operating_workspace_id, operating_workspace_link_id)')
    expect(migration).toContain("capability_key in ('customer_inbox_response')")
    expect(migration).toContain("resource is already linked to another relationship")
  })

  it('fails closed and reevaluates ready jobs to blocked after resource revocation', () => {
    expect(migration).toContain("'relationship_not_client'")
    expect(migration).toContain("'missing_operating_workspace'")
    expect(migration).toContain("'missing_relationship_operating_resource'")
    expect(migration).not.toContain('select j.*, r.relationship_state into v_job, v_relationship_state')
    expect(migration).toContain('caye_revoke_relationship_resource')
    expect(migration).toContain('perform public.caye_reevaluate_job(p_workspace_id, v_job_id, p_revoked_at)')
    expect(migration).not.toContain("update public.caye_jobs set status = 'active'")
  })

  it('serializes resource revocation and readiness through relationship-before-job locking', () => {
    const readinessStart = migration.indexOf('create or replace function public.caye_phase4a_job_readiness')
    const readinessEnd = migration.indexOf('create or replace function public.caye_record_commercial_engagement')
    const readiness = migration.slice(readinessStart, readinessEnd)
    const revocationStart = migration.indexOf('create or replace function public.caye_revoke_relationship_resource')
    const revocationEnd = migration.indexOf('create or replace function public.caye_create_authorized_job')
    const revocation = migration.slice(revocationStart, revocationEnd)

    expect(readiness.indexOf('for update of r')).toBeGreaterThan(-1)
    expect(readiness.indexOf('for update of r')).toBeLessThan(readiness.indexOf('for update;'))
    const resourceLock = revocation.indexOf("where id = p_resource_id and workspace_id = p_workspace_id and status = 'verified'\n    for update")
    const relationshipLock = revocation.indexOf("where id = v_relationship_id and workspace_id = p_workspace_id\n    for update")
    const resourceMutation = revocation.indexOf("set status = 'revoked'")
    const jobScan = revocation.indexOf('for v_job_id in select id from public.caye_jobs')
    expect(resourceLock).toBeGreaterThan(-1)
    expect(resourceLock).toBeLessThan(relationshipLock)
    expect(relationshipLock).toBeLessThan(resourceMutation)
    expect(resourceMutation).toBeLessThan(jobScan)
  })

  it('restricts every new public-schema table and mutation RPC to the service role', () => {
    for (const table of ['caye_commercial_engagements', 'caye_relationship_operating_workspaces', 'caye_relationship_resources']) {
      expect(migration).toContain(`alter table public.${table} enable row level security`)
    }
    expect(migration).toContain('grant execute on function public.caye_record_commercial_engagement')
    expect(migration).toContain('to service_role')
  })
})
