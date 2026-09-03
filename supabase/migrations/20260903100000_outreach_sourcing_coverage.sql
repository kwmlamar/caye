-- Lead-sourcing supply fix. The daily autonomous sourcing cron
-- (outreach-sourcing-scan -> lib/outreach-sourcing-job.ts) re-issued the
-- same 10 fixed (vertical, region) queries against Google Places every
-- day and always took the first 20 results of a deterministic ~60-200
-- result set (Places text search is deterministic for a fixed query). The
-- addressable universe as built (~200 businesses) was fully consumed
-- within two days (2026-08-21), and every run since found ~180 "new"
-- results per day that were entirely duplicates or already-rejected
-- repeats of what a prior run already read — net-new inserts collapsed
-- to 0-2/day against a 50/day send cap.
--
-- This adds a durable per-target cursor so lib/outreach-sourcing-job.ts can
-- resume a query's result set where the last run left off instead of
-- re-reading the same head of the list, and rotate through several
-- query-string variants per vertical (lib/outreach-sourcing.ts
-- VERTICAL_QUERY_VARIANTS, e.g. "tour operator" -> boat tour, snorkel
-- trip, charter, ...) once a variant's result set is exhausted, so the
-- query space actually widens across runs instead of staying fixed.
--
-- Google's Places `next_page_token` is short-lived (expires in minutes)
-- and cannot be persisted across a ~24h cron interval, so the cursor is a
-- plain offset into a query variant's already-paginated (up to 60,
-- capped client-side in lib/outreach-sourcing.ts textSearch) result list,
-- not a stored token.

alter table public.outreach_sourcing_targets
  add column query_variant_index integer not null default 0,
  add column result_offset integer not null default 0;

comment on column public.outreach_sourcing_targets.query_variant_index is
  'Index into this target''s vertical query-string variant list (lib/outreach-sourcing.ts VERTICAL_QUERY_VARIANTS -- e.g. "tour operator" rotates through boat tour, snorkel trip, charter, excursion, island tour, fishing charter, water sports). Advanced (wrapping) by lib/outreach-sourcing-job.ts advanceSourcingCursor() once result_offset reaches the end of the current variant''s Places result set, so successive sourcing runs widen the query space instead of repeating the same string forever. A vertical not present in VERTICAL_QUERY_VARIANTS falls back to a single-variant list (the vertical string itself), so this index is always in range.';

comment on column public.outreach_sourcing_targets.result_offset is
  'Offset into the current query variant''s Google Places text-search result set (capped ~60 results by Places-side pagination) that the next sourcing run for this target should resume from. Deliberately NOT a Places next_page_token -- those expire in minutes and cannot survive the ~24h interval between cron runs. Reset to 0 whenever query_variant_index advances to a new variant.';
