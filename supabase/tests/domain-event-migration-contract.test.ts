import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const bridge = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260901_domain_event_projection_bridge.sql'),
  'utf8',
)
const fixes = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260902043000_domain_integration_review_fixes.sql'),
  'utf8',
)

describe('domain integration migration contract', () => {
  it('keeps event idempotency and stale guards', () => {
    expect(bridge).toContain('workspace_events_domain_idempotency_unique_idx')
    expect(bridge).toContain("return jsonb_build_object('status', 'stale'")
  })

  it('uses UUID identity consistently across the ingestion RPC and corrected observation state', () => {
    expect(bridge).toContain('p_caye_entity_id uuid')
    expect(bridge).toContain('uuid,text,text,text,text,uuid,text,timestamptz')
    expect(fixes).toContain('alter column caye_entity_id type uuid')
  })

  it('enforces workspace-safe artifact and entity provenance', () => {
    expect(fixes).toContain('business_entity_relations_source_artifact_workspace_fkey')
    expect(fixes).toContain('domain_entity_observation_state_entity_workspace_fkey')
  })

  it('indexes the exact observation-time expression used by domain catch-up', () => {
    expect(fixes).toContain('workspace_events_domain_observed_at_idx')
    expect(fixes).toContain("payload ->> 'observed_at'")
    expect(fixes).toContain("where type like 'domain.%'")
  })

  it('aligns credential refs with the runtime resolver', () => {
    expect(fixes).toContain("^[a-z0-9_]{1,64}$")
  })

  it('does not write business facts or Bedrock', () => {
    expect(bridge + fixes).not.toContain('insert into public.business_facts')
    expect(bridge + fixes).not.toContain('update public.business_facts')
  })
})
