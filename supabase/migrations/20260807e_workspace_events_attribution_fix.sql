-- 2026-08-07 — workspace_events: attribution corrections
--
-- Two defects found by verifying 20260807d against the backfilled data.
--
-- DEFECT 1 — CASE precedence disagreed between `type` and `actor_kind`.
-- `type` tested is_internal first; `actor_kind` tested sender_type first. Six
-- legacy rows (customer-sent messages flagged is_internal, from a May 2026
-- partnership thread) came out typed 'message.internal_note' with actor_kind
-- 'outside'. That combination is not merely untidy: the read layer's default
-- lens reports anything the outside world did, so internal notes would have
-- been surfaced as guest activity. Both expressions now test is_internal first.
--
-- DEFECT 2 — untagged outbound was guessed as 'operator'.
-- 364 of 504 non-internal business messages carry no metadata.generated_by:
--
--   workspace                     null    'caye'
--   Bimini      (653257d9)         167       102
--   TropiTech O (7c0537ff)         168        31
--   (29227a12)                      29         7
--
-- Those 168 on TropiTech Outreach are the cold-outreach sends. Attributing
-- them to 'operator' asserts that Lamar hand-typed 168 cold emails. He did
-- not. But the opposite guess is no better — Bimini's 167 are a genuine mix
-- of Karenda replying from her own mail client and Caye sending, and nothing
-- in the row distinguishes them.
--
-- This is the same principle bookings.source already follows: when
-- provenance was never recorded, say 'unknown' rather than manufacture a
-- fact. A growing 'unknown' count is a visible gap; a confident wrong label
-- is invisible and poisons every metric built on it.
--
-- NOTE ON WHAT TRIGGER-DERIVATION DOES AND DOESN'T BUY
-- 20260807d guarantees "if the row exists, the event exists". It does NOT
-- guarantee the event is correctly attributed — the trigger can only record
-- what the source row carries. The real fix for defect 2 is upstream: every
-- Caye send path must set metadata.generated_by. Until then 'unknown' is the
-- honest reading, and this migration deliberately does not backfill a guess
-- over it.
--
-- Reversible: re-apply the function bodies from 20260807d.

alter table public.workspace_events
  drop constraint if exists workspace_events_actor_kind_check;

alter table public.workspace_events
  add constraint workspace_events_actor_kind_check
  check (actor_kind in ('outside', 'caye', 'operator', 'system', 'unknown'));

create or replace function public.caye_event_on_unified_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ws uuid;
begin
  ws := public.caye_workspace_for_conversation(new.conversation_id);
  if ws is null then
    return new;
  end if;

  insert into public.workspace_events
    (workspace_id, occurred_at, type, actor_kind, is_failure,
     subject_table, subject_id, conversation_id, payload)
  values (
    ws,
    new.sent_at,
    case
      when new.is_internal then 'message.internal_note'
      when new.sender_type = 'customer' then 'message.inbound'
      else 'message.outbound'
    end,
    case
      -- is_internal first, matching the type expression above.
      when new.is_internal then 'caye'
      when new.sender_type = 'customer' then 'outside'
      when coalesce(new.metadata->>'generated_by', '') = 'caye' then 'caye'
      -- No generated_by means nobody recorded who sent it. Do not guess.
      else 'unknown'
    end,
    new.failed_at is not null,
    'unified_messages',
    new.id::text,
    new.conversation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'sender_type', new.sender_type::text,
      'is_internal', new.is_internal,
      'preview', left(coalesce(new.content, ''), 200),
      'generated_by', new.metadata->>'generated_by',
      'is_correction', new.metadata->>'is_correction'
    ))
  );
  return new;
end;
$$;

-- Repair the rows the original trigger and backfill already wrote.
update public.workspace_events
   set actor_kind = 'caye'
 where type = 'message.internal_note'
   and actor_kind <> 'caye';

update public.workspace_events
   set actor_kind = 'unknown'
 where type = 'message.outbound'
   and actor_kind = 'operator'
   and coalesce(payload->>'generated_by', '') <> 'caye';
