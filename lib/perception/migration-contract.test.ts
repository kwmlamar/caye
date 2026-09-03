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

  it('normalizes channel message activity from the existing canonical message stream, workspace-scoped', () => {
    const sql = migration('20260902150000_perception_channel_and_booking_sources.sql')
    expect(sql).toContain("from public.workspace_events")
    expect(sql).toContain("type = 'message.inbound'")
    expect(sql).toContain("from public.unified_conversations")
    expect(sql).toContain("v_source_kind := 'channel.' || v_channel_type")
    expect(sql).toContain("subject_kind = 'unified_conversation'")
    expect(sql).toContain('workspace_id = v_latest.workspace_id')
    expect(sql).toContain("'epistemic_kind', 'observation'")
    expect(sql).toContain("'anomaly', false")
  })

  it('only writes observation.channel_activity for initial/changed state, never for an unchanged poll', () => {
    const sql = migration('20260902150000_perception_channel_and_booking_sources.sql')
    expect(sql).toContain("if v_change_kind <> 'unchanged' then")
    expect(sql).toContain("'observation.channel_activity'")
  })

  it('normalizes booking state from the existing canonical booking event stream instead of re-querying bookings', () => {
    const sql = migration('20260902150000_perception_channel_and_booking_sources.sql')
    expect(sql).toContain("type in ('booking.created', 'booking.status_changed')")
    expect(sql).toContain("subject_table = 'bookings'")
    expect(sql).not.toContain('from public.bookings')
    expect(sql).not.toContain('update public.bookings')
    expect(sql).toContain("subject_kind = 'booking'")
    expect(sql).toContain("'observation.booking_state'")
  })

  it('derives booking importance as classification only, never as anomaly or send/mutate authority', () => {
    const sql = migration('20260902150000_perception_channel_and_booking_sources.sql')
    expect(sql).toContain("v_status in ('cancelled', 'no_show')")
    expect(sql).toContain("v_importance := 'notice'")
    expect(sql).toContain("'anomaly', false")
    expect(sql).not.toMatch(/'anomaly',\s*true/)
    expect(sql).not.toContain('sendWhatsAppMessage')
    expect(sql).not.toContain('send_message')
    expect(sql).not.toContain('update public.bookings')
    expect(sql).not.toContain('insert into public.caye_escalations')
    expect(sql).not.toContain('insert into public.owner_attention')
  })

  it('keeps both new sources workspace-scoped, service-role only, and folded into the existing bounded cron RPC', () => {
    const sql = migration('20260902150000_perception_channel_and_booking_sources.sql')
    expect(sql).toContain('create or replace function public.run_workspace_event_perception_cycle(p_limit integer default 100)')
    expect(sql).toContain('public.run_channel_activity_perception_cycle(v_limit)')
    expect(sql).toContain('public.run_booking_state_perception_cycle(v_limit)')
    expect(sql).toContain('revoke all on function public.observe_channel_message_activity(uuid, timestamptz) from public, anon, authenticated')
    expect(sql).toContain('grant execute on function public.observe_channel_message_activity(uuid, timestamptz) to service_role')
    expect(sql).toContain('revoke all on function public.observe_booking_state(text, timestamptz) from public, anon, authenticated')
    expect(sql).toContain('grant execute on function public.observe_booking_state(text, timestamptz) to service_role')
  })
})
