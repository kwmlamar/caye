-- 2026-08-07 — bookings.source
--
-- Phase 0 of briefs/workspace-events-plan.md.
--
-- WHY
-- `bookings` has 621 rows and no way to tell where any of them came from.
-- Verified before writing this: 10 of 616 Bimini bookings carry a
-- conversation_id and 11 carry a customer_email, so the overwhelming
-- majority arrived by a route nothing in the system recorded — typed in by
-- hand, imported, or taken by phone and entered later.
--
-- Without this column every metric Caye computes is uninterpretable. She
-- cannot separate "I booked this" from "someone told me this happened",
-- which means she can never answer whether her own replies convert, and any
-- business insight she produces silently averages the two together.
--
-- VALUES
--   caye     — created by Caye from a conversation she handled
--   manual   — entered by an operator (dashboard, or told to Caye in chat)
--   import   — bulk-loaded from a prior system
--   unknown  — provenance genuinely not recorded
--
-- BACKFILL POSTURE: deliberately conservative. Rows with a conversation_id
-- become 'caye' because that link is only ever written by the conversation
-- booking path. Everything else becomes 'unknown' rather than 'import' —
-- we do not actually know that the other 611 were imported, and guessing
-- 'import' would manufacture a fact. 'unknown' is the honest state and it
-- reads as a gap in any query that groups by source, which is the point.
--
-- New rows default to 'unknown' on purpose: a write path that forgets to
-- set source shows up as a growing unknown count instead of quietly
-- mislabelling itself as manual.
--
-- Reversible: alter table public.bookings drop column source.

alter table public.bookings
  add column if not exists source text not null default 'unknown';

alter table public.bookings
  drop constraint if exists bookings_source_check;

alter table public.bookings
  add constraint bookings_source_check
  check (source in ('caye', 'manual', 'import', 'unknown'));

update public.bookings
   set source = 'caye'
 where conversation_id is not null
   and source = 'unknown';

comment on column public.bookings.source is
  'Where this booking came from: caye | manual | import | unknown. Defaults to unknown so a write path that forgets to set it is visible rather than mislabelled. See briefs/workspace-events-plan.md.';
