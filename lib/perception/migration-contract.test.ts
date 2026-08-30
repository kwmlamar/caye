import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

function migration(name: string) {
  return readFileSync(join(process.cwd(), 'supabase', 'migrations', name), 'utf8')
}

describe('perception migration contract', () => {
  it('keeps perception state workspace-scoped and service-role only', () => {
    const sql = migration('20260830e_perception_continuous_awareness.sql')
    expect(sql).toContain('unique (workspace_id, source_kind, source_identity, subject_kind, subject_id)')
    expect(sql).toContain('unique (workspace_id, capability_key, source_kind, source_identity)')
    expect(sql).toContain('alter table public.perception_source_state enable row level security')
    expect(sql).toContain('alter table public.perception_capability_evidence enable row level security')
    expect(sql).toContain('from public, anon, authenticated')
    expect(sql).toContain('to service_role')
  })

  it('resolves device authority server-side instead of accepting a workspace from ingress', () => {
    const sql = migration('20260830e_perception_continuous_awareness.sql')
    expect(sql).toContain('from public.property_sensor_devices')
    expect(sql).toContain('where provider = p_provider')
    expect(sql).toContain("return jsonb_build_object('status', 'unknown_device')")
    expect(sql).not.toMatch(/p_workspace_id\s+/)
  })

  it('suppresses delayed telemetry from the canonical change stream without deleting raw history', () => {
    const sql = migration('20260830h_perception_suppress_out_of_order_events.sql')
    expect(sql).toContain('where workspace_id = new.workspace_id')
    expect(sql).toContain("source_kind = v_source_kind")
    expect(sql).toContain('subject_id = v_subject_id')
    expect(sql).toContain('new.occurred_at < v_current_observed_at')
    expect(sql).toContain('return null')
    expect(sql).toContain('before insert on public.workspace_events')
  })

  it('serializes provider-event collisions and rejects cross-device or cross-workspace duplicates', () => {
    const sql = migration('20260830i_perception_duplicate_scope_guard.sql')
    expect(sql).toContain('pg_advisory_xact_lock')
    expect(sql).toContain('provider_event_id = new.provider_event_id')
    expect(sql).toContain('v_existing_device_id is distinct from new.device_id')
    expect(sql).toContain('v_existing_workspace_id is distinct from new.workspace_id')
    expect(sql).toContain("raise exception 'Telemetry provider event identity collides across registered source scope'")
  })

  it('preserves monotonic current-state projections under out-of-order updates', () => {
    const sql = migration('20260830f_perception_monotonic_state.sql')
    expect(sql).toContain('new.last_observed_at < old.last_observed_at')
    expect(sql).toContain('new.last_fingerprint := old.last_fingerprint')
    expect(sql).toContain('new.fresh_until := old.fresh_until')
    expect(sql).toContain('new.evidence_event_id := old.evidence_event_id')
  })

  it('keeps rejected-but-authenticated telemetry as heartbeat evidence only', () => {
    const sql = migration('20260830g_perception_telemetry_rejected_heartbeat.sql')
    expect(sql).toContain("new.processing_status = 'rejected'")
    expect(sql).toContain('greatest(last_seen_at, new.observed_at)')
    expect(sql).not.toContain('workspace_events')
    expect(sql).not.toContain('perception_capability_evidence')
  })
})
