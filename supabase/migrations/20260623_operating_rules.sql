-- Operating rules: business-wide closures + weekday routing.
--
-- Why: Caye's check_availability (lib/caye-reply.ts) only knew about existing
-- bookings + slot capacity. It had no concept of closed dates (Karenda's
-- Dec 23–Jan 3 and Aug 1–9 closures) or weekdays she handles personally
-- (Sundays — driver Max is at church until 11am). Zoho holds those closures as
-- all-day events, which the inbound sync skips, so they never reached Caye.
--
-- These are deterministic business policy, so we store them explicitly rather
-- than inferring from calendar event titles.

ALTER TABLE workspace_ai_config
  -- Array of closure ranges. Each: { start, end, label?, recurring_annually? }.
  -- recurring_annually=true → start/end are 'MM-DD' and match any year (the
  -- Dec 23–Jan 3 range wraps the year boundary). Otherwise 'YYYY-MM-DD'.
  ADD COLUMN blackout_dates jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Weekdays (0=Sunday .. 6=Saturday) where Caye must NOT auto-quote/book and
  -- instead routes the inquiry to the owner. Empty = Caye handles every weekday.
  ADD COLUMN owner_only_weekdays smallint[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN workspace_ai_config.blackout_dates IS
  'Closure ranges: [{start,end,label?,recurring_annually?}]. recurring_annually uses MM-DD and matches any year (supports year-boundary wrap).';
COMMENT ON COLUMN workspace_ai_config.owner_only_weekdays IS
  'Weekdays (0=Sun..6=Sat) routed to the owner instead of auto-handled by Caye.';
