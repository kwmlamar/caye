-- 2026-08-13 — Caye Direct topic threads
--
-- Caye Direct was organized by PERSON (Lamar/Max/Mrs. Max as separate chat
-- destinations) — a messaging-app shape that misrepresents the product.
-- Caye actually has one continuous WhatsApp relationship with each operator
-- (unbounded, no thread concept, and it must stay that way — see
-- lib/caye-agent/context.ts) and, separately, a ChatGPT-style persistent
-- conversation history with the founder. This migration adds the founder-
-- facing thread layer without touching the operator/WhatsApp model at all.
--
-- caye_operator_messages remains the canonical, untouched raw-event log —
-- both WhatsApp and dashboard turns still write there exactly as before.
-- Threads are a pure organization layer on top: a message can belong to
-- zero, one, or several threads (a single WhatsApp message can touch
-- multiple subjects — see relate_to_direct_thread), so this is a many-to-
-- many join, not a column on the message row.
--
-- NAMING: deliberately `caye_direct_threads`, not `caye_threads` — that
-- name is already taken by an unrelated, live table pair (20260528) backing
-- the separate CUSTOMER dashboard's own "chat with Caye" widget, RLS'd to
-- auth.uid(). Different product, different owner, different auth model —
-- colliding names would be a real hazard here, not just an aesthetic one.
--
-- subject_type/subject_id on caye_direct_thread_entities reuses the exact
-- polymorphic shape already proven by workspace_events and
-- caye_owner_attention: deliberately text, not an enum, so a new linkable
-- entity kind (person, inbox conversation, booking, lead, escalation,
-- business fact, work item) never needs a migration to add.

-- ── caye_operator_messages: distinguish dashboard-typed vs WhatsApp-
-- originated turns. Genuine gap — nothing today reliably tells "Lamar
-- typed this in Caye Direct" apart from "this arrived over WhatsApp", and
-- the redesigned UI needs it to badge "Max · via WhatsApp" on messages
-- surfaced inside a thread. Defaults to 'whatsapp' since that's the
-- overwhelming majority of existing rows; the dashboard route sets
-- 'dashboard' explicitly going forward.
alter table public.caye_operator_messages
  add column if not exists origin text not null default 'whatsapp'
    check (origin in ('whatsapp', 'dashboard'));

-- ── The thread itself. Founder-facing only — operators never see or
-- manage threads (see relate_to_direct_thread in the back-office tool
-- registry, which links WhatsApp turns into threads silently on their
-- behalf). created_by distinguishes a thread Lamar started from one Caye
-- surfaced unprompted (escalation-followup, opportunity-scan).
create table if not exists public.caye_direct_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  title text,
  status text not null default 'active' check (status in ('active', 'archived')),
  -- Rolling compact summary — NOT Memory. Freely discarded/regenerated,
  -- never written to business_facts/caye_standing_rules/customer-profile.
  -- Lets a long-idle thread resume without replaying its full history.
  summary text,
  summary_updated_at timestamptz,
  created_by text not null check (created_by in ('founder', 'caye')),
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists caye_direct_threads_workspace_idx
  on public.caye_direct_threads(workspace_id, status, last_activity_at desc);

comment on table public.caye_direct_threads is
  'Founder-facing topic threads over Caye Direct. Organization layer only — caye_operator_messages stays the canonical raw-event log for both WhatsApp and dashboard turns.';

-- ── Many-to-many: a raw caye_operator_messages row can be linked into
-- zero, one, or several threads. Deliberately NOT a thread_id column on
-- caye_operator_messages — a single WhatsApp message touching multiple
-- subjects ("Emily's fine at $275, also stop following up with Ruslan")
-- must not be forced into exclusive ownership by one thread.
create table if not exists public.caye_direct_thread_messages (
  thread_id uuid not null references public.caye_direct_threads(id) on delete cascade,
  message_id uuid not null references public.caye_operator_messages(id) on delete cascade,
  linked_by text not null check (linked_by in ('founder', 'caye', 'system')),
  linked_at timestamptz not null default now(),
  primary key (thread_id, message_id)
);

create index if not exists caye_direct_thread_messages_message_idx
  on public.caye_direct_thread_messages(message_id);

comment on table public.caye_direct_thread_messages is
  'Join table linking caye_operator_messages rows into caye_direct_threads. Many-to-many by design — see migration header.';

-- ── Polymorphic linked entities — how a thread references People, Inbox
-- conversations, bookings, leads, escalations, business facts, work items
-- WITHOUT duplicating their data. Stores only the pointer; rendering
-- resolves the canonical record by (subject_type, subject_id). Also the
-- lookup getOrCreateDirectThread uses to decide whether an existing thread
-- should be reused instead of a new one spawned for the same subject.
create table if not exists public.caye_direct_thread_entities (
  id bigint generated always as identity primary key,
  thread_id uuid not null references public.caye_direct_threads(id) on delete cascade,
  subject_type text not null,
  subject_id text not null,
  created_at timestamptz not null default now(),
  unique (thread_id, subject_type, subject_id)
);

create index if not exists caye_direct_thread_entities_subject_idx
  on public.caye_direct_thread_entities(subject_type, subject_id);

comment on table public.caye_direct_thread_entities is
  'Polymorphic pointers from a thread to canonical workspace entities (person, inbox_conversation, booking, lead, escalation, business_fact, work_item). Also the reuse key for getOrCreateDirectThread.';

-- ── RLS: enabled, zero policies — matches every other caye_* table in
-- this codebase (20260807b, 20260812c). Deliberately deny-by-default:
-- these tables are read/written only via createServiceClient() from
-- server-side routes/tools. If a future client-side feature needs direct
-- access, it should fail loudly and get an explicit, reviewed policy —
-- not a default-open one added here for convenience.
alter table public.caye_direct_threads enable row level security;
alter table public.caye_direct_thread_messages enable row level security;
alter table public.caye_direct_thread_entities enable row level security;
