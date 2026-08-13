-- Formally track the contacts_email_workspace_unique index — it has existed
-- live since the Zoho email webhook's contact upsert went in, but was never
-- captured by a tracked migration (see 20260703_contacts_channel_identity_
-- unique.sql's own comment calling this out). Idempotent: this index already
-- exists in every environment, so this migration is a no-op there and only
-- matters for a fresh environment built from migration history.
--
-- Enforces one contacts row per (workspace, email) — the dedup key
-- lib/contacts/resolve-contact.ts's email/gmail branch upserts against.
create unique index if not exists contacts_email_workspace_unique
  on contacts (customer_id, email)
  where channel_type = 'email' and email is not null;
