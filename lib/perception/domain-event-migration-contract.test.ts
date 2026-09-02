import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260901_domain_event_projection_bridge.sql'),
  'utf8',
)

describe('external domain event projection migration', () => {
  it('makes normalized domain event writes deterministically idempotent', () => {
    expect(sql).toContain('workspace_events_domain_idempotency_unique_idx')
    expect(sql).toContain("payload #>> '{source,idempotency_key}'")
    expect(sql).toContain("type like 'domain.%'")
  })

  it('keeps durable source cursor and per-entity stale guards workspace/company scoped', () => {
    expect(sql).toContain('domain_sync_cursors')
    expect(sql).toContain('domain_entity_observation_state')
    expect(sql).toContain('unique (workspace_id, source_system, source_company_id, stream)')
    expect(sql).toContain('unique (workspace_id, source_system, source_company_id, source_entity_type, source_entity_id)')
  })

  it('suppresses stale operational updates while permitting safe replay', () => {
    expect(sql).toContain("return jsonb_build_object('status', 'stale'")
    expect(sql).toContain("return jsonb_build_object('status', 'duplicate'")
    expect(sql.match(/pg_advisory_xact_lock/g)).toHaveLength(2)
  })

  it('does not create or write business facts', () => {
    expect(sql).not.toContain('insert into public.business_facts')
    expect(sql).not.toContain('update public.business_facts')
  })
})
