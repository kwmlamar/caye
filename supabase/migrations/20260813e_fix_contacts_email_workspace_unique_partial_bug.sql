-- contacts_email_workspace_unique was a PARTIAL unique index
-- (WHERE channel_type = 'email' AND email IS NOT NULL). Postgres requires
-- an ON CONFLICT clause to restate a partial index's predicate verbatim to
-- use it as an arbiter — but PostgREST's upsert API (onConflict: column
-- list only, no predicate support) can never do that. Every email-channel
-- contact upsert in production (zoho-email webhook, and every new email/
-- gmail poller path added in the people-identity-ingestion fix) has been
-- silently failing with "there is no unique or exclusion constraint
-- matching the ON CONFLICT specification" and swallowing the error via a
-- console.warn(...continuing) catch — found while running the orphan
-- backfill: every real email failed to resolve, 0 contacts created.
--
-- Fix: a plain (non-partial) unique index on (customer_id, email) is
-- actually sufficient — Postgres treats every NULL as distinct, so social-
-- channel contacts (email IS NULL) never collide with each other or with
-- email contacts. No WHERE clause needed, which is exactly what makes it
-- resolvable via PostgREST's column-list-only onConflict.
--
-- Verified no existing (customer_id, email) duplicates before applying
-- (`select customer_id, email, count(*) ... having count(*) > 1` → 0 rows).
drop index if exists contacts_email_workspace_unique;

create unique index if not exists contacts_email_workspace_unique
  on contacts (customer_id, email);
