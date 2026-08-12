-- Shared owner-attention state — one ledger of what Caye has told the owner,
-- about which item, and where each item stands.
--
-- 2026-08-12: at ~09:00 Mrs. Max's WhatsApp received "B2B enquiry — needs
-- your call." about Ruslan Prakapovich. ~30 minutes later the morning digest
-- told her "no new threads need your immediate attention," describing the
-- same item as "already on its own follow-up cadence." Both messages were
-- individually correct. Together they said Caye does not read her own
-- messages, which is worse than either being wrong.
--
-- WHY A NEW TABLE AND NOT MORE COLUMNS SOMEWHERE.
--   * caye_escalations tracks ONE kind of attention item and already carries
--     owner_responded_at/expired_at. It cannot hold a held conversation, a
--     pending quote, or a reminder, and widening it to would make "escalation"
--     mean nothing.
--   * caye_operator_messages IS the record of what Caye said, but as prose.
--     You cannot ask it "which items have I already surfaced" without
--     re-reading English.
--   * unified_conversations.human_agent_* is per-conversation and says nothing
--     about notification.
-- The missing layer is the JOIN between "an item needs attention" and "the
-- owner has been told, and here is what they were told" — which is exactly
-- what every composer needs and none of them had.
--
-- CHANNEL-AGNOSTIC BY CONSTRUCTION. No phone number, no WhatsApp concept, no
-- Caye Direct concept. A new surface (SMS, email digest, dashboard badge)
-- reads the same rows and calls the same markNotified.

create table if not exists caye_owner_attention (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,

  -- WHAT THE ITEM IS. (subject_type, subject_id) is the stable identity of
  -- the underlying thing across every time it gets surfaced. Deliberately
  -- text, not an enum, for the same reason as caye_pending_operations.
  -- operation: adding a kind must never require a migration to land first.
  subject_type text not null,
  subject_id text not null,

  -- Denormalised for the composers, which must not need a join per item to
  -- write one line of a briefing.
  conversation_id uuid,
  title text not null,

  -- The attention tier. 'decision' means it genuinely needs the owner;
  -- 'awareness' means it does not and must never be phrased as a question.
  priority text not null default 'awareness'
    check (priority in ('critical', 'decision', 'awareness', 'routine')),

  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'decided', 'resolved', 'dismissed')),

  -- THE NOTIFICATION LEDGER. This is the half that did not exist.
  first_notified_at timestamptz,
  last_notified_at timestamptz,
  notify_count int not null default 0,
  -- What Caye actually told the owner last time, verbatim. Lets a composer
  -- avoid repeating itself, and lets it say "still open" instead of
  -- re-explaining from scratch.
  last_notified_summary text,

  -- OWNER RESPONSE.
  acknowledged_at timestamptz,
  decided_at timestamptz,
  decision text,

  -- CAYE'S FOLLOW-THROUGH.
  next_action text,
  completed_at timestamptz,

  -- CHANGE DETECTION. A hash of the item's meaningful state, written by the
  -- producer. Briefings compare it against the value at last_notified_at:
  -- equal means nothing has changed and the item must NOT be re-surfaced as
  -- if it were new. This is what turns "regenerate a summary of everything"
  -- into "what changed since I last spoke to you".
  state_fingerprint text,
  notified_fingerprint text,
  last_changed_at timestamptz not null default now(),

  -- The InboundDigest (lib/inbound-digest.ts) when this item came from a
  -- message. Kept so the owner can ask for detail without Caye re-reading
  -- the original, and so a follow-up briefing has the facts to hand.
  digest jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per underlying item per workspace. Re-observing the same item is an
-- update, never a second row — that is what stops three sightings of one
-- conversation becoming three "urgent" lines in a briefing.
create unique index if not exists caye_owner_attention_subject_idx
  on caye_owner_attention (workspace_id, subject_type, subject_id);

-- The composers' read: what is still open here, most pressing first.
create index if not exists caye_owner_attention_open_idx
  on caye_owner_attention (workspace_id, priority, last_changed_at desc)
  where status in ('open', 'acknowledged');

create index if not exists caye_owner_attention_conversation_idx
  on caye_owner_attention (conversation_id)
  where conversation_id is not null;

comment on table caye_owner_attention is
  'What Caye has told the owner, about which item, and where it stands. The shared state every composer reads before speaking, so two of them cannot contradict each other. Service-role only.';
comment on column caye_owner_attention.state_fingerprint is
  'Hash of the item''s meaningful state now. Compare to notified_fingerprint: equal means nothing changed since the owner was told, so do not re-surface as new.';
comment on column caye_owner_attention.notified_fingerprint is
  'state_fingerprint as it was at last_notified_at.';
comment on column caye_owner_attention.priority is
  'awareness/routine items must never be phrased as a question to the owner. decision/critical are the only tiers allowed to ask for something.';

-- Service-role only, matching every other caye_* table. RLS on with zero
-- policies is the intended deny-by-default state (see 20260807b), not an
-- unfinished job.
alter table caye_owner_attention enable row level security;
