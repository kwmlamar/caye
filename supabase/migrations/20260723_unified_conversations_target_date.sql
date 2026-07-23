-- Plain-hold dead-date fix (2026-07-23): unified_conversations previously had
-- no date-awareness at all for held conversations, unlike caye_escalations
-- (which already has target_date). A held booking ask for a date that's
-- since passed would repeat the same stale reminder forever with no signal
-- that the specific date was dead. Captured once at hold-creation time
-- (see lib/whatsapp/urgency.ts's extractHoldTargetDate), read by
-- stale-hold-sweep to immediately flag dead-date holds instead of waiting
-- for the usual aging cycle. Nullable -- most holds have no extractable
-- date and this column stays null for them.
alter table unified_conversations
  add column if not exists target_date date;
