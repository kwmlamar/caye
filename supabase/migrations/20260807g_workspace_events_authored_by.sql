-- 2026-08-07 — teach the message trigger about metadata.authored_by
--
-- Phase 2 of briefs/workspace-events-plan.md, the upstream half.
--
-- 20260807e left outbound messages as actor_kind='unknown' whenever
-- metadata.generated_by was absent, because guessing was worse than admitting
-- ignorance. lib/message-authorship.ts now removes the ignorance at the
-- source: /api/messages/send compares the sent text against the Caye draft
-- stored on the thread and records who actually composed it.
--
--   authored_by = 'caye'          — Caye's words, sent unedited (a human may
--                                   still have clicked send; sent_by covers that)
--   authored_by = 'human_edited'  — started from Caye's draft, changed before
--                                   sending. A graded wrong answer, and the
--                                   only accuracy signal the product has.
--   authored_by = 'human'         — no draft existed; the sender wrote it.
--
-- Precedence is authored_by first, then generated_by, then unknown.
-- generated_by stays in the chain because the channel-dispatch, webhook and
-- nudge-scan paths set it directly and are already correct — this is
-- additive, not a replacement.
--
-- 'human_edited' maps to actor_kind='operator': the words that went to the
-- guest are the operator's. The fact that Caye drafted it survives in
-- payload.authored_by for anyone measuring correction rate.
--
-- Historical rows are NOT rewritten. The draft that a 2026-07 send was or
-- was not based on is gone, so backfilling authorship would be the same
-- manufactured fact 20260807e refused to write. They stay 'unknown'.
--
-- Reversible: re-apply the function body from 20260807e.

create or replace function public.caye_event_on_unified_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ws uuid;
  authored text;
begin
  ws := public.caye_workspace_for_conversation(new.conversation_id);
  if ws is null then
    return new;
  end if;

  authored := new.metadata->>'authored_by';

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
      when new.is_internal then 'caye'
      when new.sender_type = 'customer' then 'outside'
      when authored = 'caye' then 'caye'
      when authored in ('human', 'human_edited') then 'operator'
      when coalesce(new.metadata->>'generated_by', '') = 'caye' then 'caye'
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
      'authored_by', authored,
      'sent_by', new.metadata->>'sent_by',
      'is_correction', new.metadata->>'is_correction'
    ))
  );
  return new;
end;
$$;

revoke execute on function public.caye_event_on_unified_message() from public, anon, authenticated;
