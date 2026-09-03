import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

/**
 * Real-SQL coverage for 20260902150000_perception_channel_and_booking_sources.sql,
 * mirroring the PGlite migration-test pattern already used elsewhere in this repo
 * (e.g. lib/property/property-intelligence.migration.test.ts). Contract-level string
 * pinning lives in lib/perception/migration-contract.test.ts; this file proves the
 * runtime behavior of the two new observers against a real Postgres engine:
 *
 *   - initial vs unchanged vs ordinary_change correlation;
 *   - unchanged polls never write a canonical observation event (no stream spam);
 *   - workspace-scoped dedupe holds even when a source identity value collides
 *     across two different workspaces;
 *   - booking importance/severity classification without anomaly detection.
 *
 * The minimal schema below is a deliberately small stand-in for the tables the new
 * migration reads/writes (workspace_events, perception_source_state,
 * perception_capability_evidence, unified_conversations) rather than replaying every
 * ancestor migration, matching the standalone-schema approach already used by
 * lib/perception/domain-observation-catchup.test.ts.
 */
describe('perception channel + booking sources migration (PGlite)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(`
      do $$
      begin
        if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
        if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
      end
      $$;

      create table public.workspace_events (
        id bigint generated always as identity primary key,
        workspace_id uuid not null,
        occurred_at timestamptz not null,
        type text not null,
        actor_kind text not null,
        is_failure boolean not null default false,
        subject_table text,
        subject_id text,
        conversation_id uuid,
        payload jsonb not null default '{}'::jsonb,
        origin text not null default 'trigger' check (origin in ('trigger', 'app')),
        created_at timestamptz not null default now()
      );

      create unique index workspace_events_perception_subject_unique_idx
        on public.workspace_events (workspace_id, type, subject_table, subject_id)
        where type like 'observation.%' and subject_table is not null and subject_id is not null;

      create table public.perception_source_state (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null,
        source_kind text not null,
        source_identity text not null,
        subject_kind text not null,
        subject_id text not null,
        actor_kind text not null default 'system',
        actor_id text,
        last_observation_event_id bigint,
        last_source_event_id text,
        last_fingerprint text,
        last_observed_at timestamptz,
        fresh_until timestamptz,
        confidence numeric(4,3) not null default 1.000,
        status text not null default 'unknown',
        consecutive_failures integer not null default 0,
        last_failure_at timestamptz,
        last_failure_code text,
        retry_after timestamptz,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (workspace_id, source_kind, source_identity, subject_kind, subject_id)
      );

      create table public.perception_capability_evidence (
        id uuid primary key default gen_random_uuid(),
        workspace_id uuid not null,
        capability_key text not null,
        source_kind text not null,
        source_identity text not null,
        status text not null,
        autonomous_now boolean not null default false,
        evidence_event_id bigint,
        last_observed_at timestamptz,
        fresh_until timestamptz,
        confidence numeric(4,3) not null default 1.000,
        notes text,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (workspace_id, capability_key, source_kind, source_identity)
      );

      create table public.unified_conversations (
        id uuid primary key default gen_random_uuid(),
        connected_account_id uuid,
        channel_type text,
        customer_name text
      );
    `)

    const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations')
    await db.exec(
      readFileSync(join(migrationsDir, '20260902150000_perception_channel_and_booking_sources.sql'), 'utf8'),
    )
  })

  afterAll(async () => {
    await db.close()
  })

  const workspaceA = '00000000-0000-0000-0000-0000000000a1'
  const workspaceB = '00000000-0000-0000-0000-0000000000b2'

  async function conversation(workspaceId: string, connectedAccountId: string, channelType: string, customer: string) {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.unified_conversations (connected_account_id, channel_type, customer_name)
       values ($1, $2, $3) returning id`,
      [connectedAccountId, channelType, customer],
    )
    return rows[0].id
  }

  async function inboundMessage(workspaceId: string, conversationId: string, subjectId: string, preview: string) {
    await db.query(
      `insert into public.workspace_events
         (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, conversation_id, payload, origin)
       values ($1, now(), 'message.inbound', 'outside', 'unified_messages', $2, $3, $4::jsonb, 'trigger')`,
      [workspaceId, subjectId, conversationId, JSON.stringify({ preview, sender_type: 'customer' })],
    )
  }

  async function bookingEvent(
    workspaceId: string,
    bookingId: string,
    type: 'booking.created' | 'booking.status_changed',
    payload: Record<string, unknown>,
  ) {
    await db.query(
      `insert into public.workspace_events
         (workspace_id, occurred_at, type, actor_kind, subject_table, subject_id, payload, origin)
       values ($1, now(), $2, 'operator', 'bookings', $3, $4::jsonb, 'trigger')`,
      [workspaceId, type, bookingId, JSON.stringify(payload)],
    )
  }

  it('writes an initial channel_activity observation carrying the required envelope', async () => {
    const conv = await conversation(workspaceA, '11111111-1111-1111-1111-111111111111', 'whatsapp', 'Ana')
    await inboundMessage(workspaceA, conv, 'msg-1', 'hi there')

    const { rows } = await db.query<{ result: Record<string, unknown> }>(
      `select observe_channel_message_activity($1::uuid, now()) as result`,
      [conv],
    )
    const result = rows[0].result as Record<string, unknown>
    expect(result.status).toBe('accepted')
    expect(result.change_kind).toBe('initial')

    const events = await db.query<{ payload: Record<string, any> }>(
      `select payload from public.workspace_events where type = 'observation.channel_activity' and workspace_id = $1`,
      [workspaceA],
    )
    expect(events.rows).toHaveLength(1)
    const payload = events.rows[0].payload
    expect(payload.epistemic_kind).toBe('observation')
    expect(payload.change_kind).toBe('initial')
    expect(payload.anomaly).toBe(false)
    expect(payload.confidence).toBe(1)
    expect(payload.source.kind).toBe('channel.whatsapp')
    expect(payload.fresh_until).toBeTruthy()

    const state = await db.query(
      `select * from public.perception_source_state where workspace_id = $1 and source_kind = 'channel.whatsapp'`,
      [workspaceA],
    )
    expect(state.rows).toHaveLength(1)
  })

  it('does not spam the canonical stream when polled again with no new message', async () => {
    const conv = await conversation(workspaceA, '22222222-2222-2222-2222-222222222222', 'email', 'Ben')
    await inboundMessage(workspaceA, conv, 'msg-2', 'invoice question')

    await db.query(`select observe_channel_message_activity($1::uuid, now())`, [conv])
    const before = await db.query(`select count(*)::int as n from public.workspace_events where type = 'observation.channel_activity'`)

    const { rows } = await db.query<{ result: Record<string, unknown> }>(
      `select observe_channel_message_activity($1::uuid, now()) as result`,
      [conv],
    )
    expect((rows[0].result as Record<string, unknown>).change_kind).toBe('unchanged')

    const after = await db.query(`select count(*)::int as n from public.workspace_events where type = 'observation.channel_activity'`)
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('writes ordinary_change when a genuinely new message arrives on an already-observed conversation', async () => {
    const conv = await conversation(workspaceA, '33333333-3333-3333-3333-333333333333', 'instagram', 'Cy')
    await inboundMessage(workspaceA, conv, 'msg-3a', 'first')
    await db.query(`select observe_channel_message_activity($1::uuid, now())`, [conv])

    await inboundMessage(workspaceA, conv, 'msg-3b', 'second')
    const { rows } = await db.query<{ result: Record<string, unknown> }>(
      `select observe_channel_message_activity($1::uuid, now()) as result`,
      [conv],
    )
    expect((rows[0].result as Record<string, unknown>).change_kind).toBe('ordinary_change')

    const events = await db.query(
      `select id from public.workspace_events where type = 'observation.channel_activity' and conversation_id = $1`,
      [conv],
    )
    expect(events.rows).toHaveLength(2)
  })

  it('keeps source-state dedupe workspace-scoped even when a source identity value collides across workspaces', async () => {
    const sharedAccountId = '44444444-4444-4444-4444-444444444444'
    const convA = await conversation(workspaceA, sharedAccountId, 'messenger', 'Same Provider Id A')
    const convB = await conversation(workspaceB, sharedAccountId, 'messenger', 'Same Provider Id B')
    await inboundMessage(workspaceA, convA, 'msg-collide-a', 'a-side')
    await inboundMessage(workspaceB, convB, 'msg-collide-b', 'b-side')

    await db.query(`select observe_channel_message_activity($1::uuid, now())`, [convA])
    await db.query(`select observe_channel_message_activity($1::uuid, now())`, [convB])

    const state = await db.query(
      `select workspace_id from public.perception_source_state where source_kind = 'channel.messenger' and source_identity = $1 order by workspace_id`,
      [sharedAccountId],
    )
    expect(state.rows).toHaveLength(2)
    expect(new Set(state.rows.map((r: any) => r.workspace_id))).toEqual(new Set([workspaceA, workspaceB]))
  })

  it('classifies booking state: initial as notice, a cancellation as a warning, and an unchanged poll as no-op', async () => {
    const bookingId = 'booking-cancel-1'
    await bookingEvent(workspaceA, bookingId, 'booking.created', {
      status: 'confirmed',
      customer: 'Dee',
      booking_date: '2026-09-10',
    })

    const initial = await db.query<{ result: Record<string, unknown> }>(
      `select observe_booking_state($1, now()) as result`,
      [bookingId],
    )
    const initialResult = initial.rows[0].result as Record<string, unknown>
    expect(initialResult.change_kind).toBe('initial')
    expect(initialResult.importance).toBe('notice')
    expect(initialResult.anomaly).toBe(false)

    await bookingEvent(workspaceA, bookingId, 'booking.status_changed', {
      from: 'confirmed',
      to: 'cancelled',
      customer: 'Dee',
      booking_date: '2026-09-10',
    })

    const changed = await db.query<{ result: Record<string, unknown> }>(
      `select observe_booking_state($1, now()) as result`,
      [bookingId],
    )
    const changedResult = changed.rows[0].result as Record<string, unknown>
    expect(changedResult.change_kind).toBe('ordinary_change')
    expect(changedResult.importance).toBe('notice')
    expect(changedResult.severity).toBe('warning')
    expect(changedResult.anomaly).toBe(false)

    const unchanged = await db.query<{ result: Record<string, unknown> }>(
      `select observe_booking_state($1, now()) as result`,
      [bookingId],
    )
    expect((unchanged.rows[0].result as Record<string, unknown>).change_kind).toBe('unchanged')

    const events = await db.query(
      `select id from public.workspace_events where type = 'observation.booking_state' and subject_id = $1`,
      [bookingId],
    )
    expect(events.rows).toHaveLength(2)
  })

  it('never mutates the source booking or conversation rows — perception is read-and-record only', async () => {
    const conv = await conversation(workspaceA, '55555555-5555-5555-5555-555555555555', 'whatsapp', 'Read Only Check')
    await inboundMessage(workspaceA, conv, 'msg-read-only', 'hello')
    await db.query(`select observe_channel_message_activity($1::uuid, now())`, [conv])

    const before = await db.query(`select customer_name from public.unified_conversations where id = $1`, [conv])
    expect(before.rows[0].customer_name).toBe('Read Only Check')

    const bookingId = 'booking-read-only-1'
    await bookingEvent(workspaceA, bookingId, 'booking.created', { status: 'confirmed', customer: 'RO', booking_date: '2026-09-11' })
    await db.query(`select observe_booking_state($1, now())`, [bookingId])

    // No public.bookings table exists in this schema at all — the observer reads
    // only from workspace_events, so there is no write path to a bookings table.
    const tableCheck = await db.query(
      `select 1 from information_schema.tables where table_schema = 'public' and table_name = 'bookings'`,
    )
    expect(tableCheck.rows).toHaveLength(0)
  })

  it('run_channel_activity_perception_cycle and run_booking_state_perception_cycle are idempotent across repeated cycles', async () => {
    const conv = await conversation(workspaceB, '66666666-6666-6666-6666-666666666666', 'email', 'Cycle Check')
    await inboundMessage(workspaceB, conv, 'msg-cycle-1', 'cycle test')
    await bookingEvent(workspaceB, 'booking-cycle-1', 'booking.created', { status: 'confirmed', customer: 'Cycle', booking_date: '2026-09-12' })

    const first = await db.query<{ result: Record<string, unknown> }>(`select run_channel_activity_perception_cycle(50) as result`)
    const firstBooking = await db.query<{ result: Record<string, unknown> }>(`select run_booking_state_perception_cycle(50) as result`)
    expect((first.rows[0].result as any).changed).toBeGreaterThan(0)
    expect((firstBooking.rows[0].result as any).changed).toBeGreaterThan(0)

    const eventsAfterFirst = await db.query(`select count(*)::int as n from public.workspace_events where type like 'observation.%'`)

    const second = await db.query<{ result: Record<string, unknown> }>(`select run_channel_activity_perception_cycle(50) as result`)
    const secondBooking = await db.query<{ result: Record<string, unknown> }>(`select run_booking_state_perception_cycle(50) as result`)
    expect((second.rows[0].result as any).changed).toBe(0)
    expect((secondBooking.rows[0].result as any).changed).toBe(0)

    const eventsAfterSecond = await db.query(`select count(*)::int as n from public.workspace_events where type like 'observation.%'`)
    expect(eventsAfterSecond.rows[0].n).toBe(eventsAfterFirst.rows[0].n)
  })
})
