-- Durable outbox for effects that must survive an external system being down.
--
-- 2026-08-11: Mrs. Max asked Caye to note a booking. The write failed and Caye
-- replied "I'd recommend jotting it down on your end for now." Nothing was
-- retried, nothing was queued, and the information existed only in a chat
-- message nobody would read again.
--
-- caye_outbound_queue already proves this pattern works for WhatsApp sends
-- (idempotency_key, failure_count, dead_letter, delivery verification). It is
-- WhatsApp-shaped though — phone numbers, templates, 24h windows — so this is
-- its general-purpose sibling rather than more columns bolted onto it.
--
-- The rule this table enforces: Supabase is the source of truth, Zoho is a
-- mirror that is allowed to be late. A booking exists the moment the row is
-- written. calendar_sync_status says whether Zoho has caught up yet.

create table if not exists caye_pending_operations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,

  -- 'zoho_calendar_upsert' | 'zoho_calendar_delete' | future external effects.
  -- Deliberately text, not an enum: adding an operation kind must never
  -- require a migration to land before the code that emits it. The enum
  -- lesson from sender_type/'system' is fresh (see lib/db-enum-literals.test.ts).
  operation text not null,

  -- Everything the worker needs to replay the effect without re-deriving it
  -- from state that may have moved on since.
  payload jsonb not null default '{}'::jsonb,

  status text not null default 'pending'
    check (status in ('pending', 'synced', 'failed', 'dead_letter', 'cancelled')),

  attempts int not null default 0,
  max_attempts int not null default 6,
  last_error text,

  -- Exponential backoff target. The worker only claims rows at or past this.
  next_attempt_at timestamptz not null default now(),

  -- Stable across retries of the same logical intent, so replaying an
  -- operation cannot create a second calendar event / second note / second
  -- anything. Unique index below is the actual enforcement.
  idempotency_key text not null,

  -- Correlates a queued effect back to the agent turn that intended it, so
  -- "why did Caye fail to create this calendar event" is one query.
  request_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  synced_at timestamptz
);

-- Enqueueing the same intent twice is a no-op, not a duplicate. This is what
-- makes retry safe at every layer above.
create unique index if not exists caye_pending_operations_idem_idx
  on caye_pending_operations (idempotency_key);

-- The worker's claim query: due, not finished, oldest first.
create index if not exists caye_pending_operations_due_idx
  on caye_pending_operations (next_attempt_at)
  where status = 'pending';

create index if not exists caye_pending_operations_workspace_idx
  on caye_pending_operations (workspace_id, created_at desc);

comment on table caye_pending_operations is
  'Durable outbox for external side effects (Zoho calendar today). Supabase holds the fact; this table holds the promise to mirror it. Service-role only.';
comment on column caye_pending_operations.idempotency_key is
  'Stable per logical intent, not per attempt. Unique — re-enqueueing is a no-op.';
comment on column caye_pending_operations.status is
  'dead_letter means max_attempts exhausted and a human has been told. It never means the underlying record was lost.';

-- Service-role only, matching every other caye_* table. RLS on with zero
-- policies is the intended deny-by-default state (see 20260807b), not an
-- unfinished job — nothing in the customer dashboard reads this.
alter table caye_pending_operations enable row level security;

-- Mirror state for the booking → Zoho Calendar leg.
--
-- zoho_event_id already exists and stays the external id; these describe
-- whether the mirror is current. Before this, a failed sync was a swallowed
-- console.error and the booking simply never appeared in the owner's
-- calendar, with nothing anywhere recording that fact.
alter table bookings
  add column if not exists calendar_sync_status text
    check (calendar_sync_status in ('pending', 'synced', 'failed', 'not_applicable')),
  add column if not exists calendar_synced_at timestamptz,
  add column if not exists calendar_sync_error text;

comment on column bookings.calendar_sync_status is
  'Whether the external calendar mirror is current. NULL = never attempted (pre-2026-08-11 rows). pending = queued in caye_pending_operations. The booking itself is real regardless.';

-- Find bookings whose mirror is behind, for the health check and for
-- answering "is anything not on my calendar?" deterministically.
create index if not exists bookings_calendar_sync_pending_idx
  on bookings (user_id, calendar_sync_status)
  where calendar_sync_status in ('pending', 'failed');
