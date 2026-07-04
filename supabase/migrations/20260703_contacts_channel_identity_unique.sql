-- Unique identity for social-channel contacts (WhatsApp/Instagram/Messenger),
-- so webhook upserts can key on (customer_id, channel_type, channel_id) the
-- same way the Zoho email path already keys on (customer_id, email) via the
-- existing (untracked) contacts_email_workspace_unique index.
create unique index if not exists contacts_channel_identity_unique
  on contacts (customer_id, channel_type, channel_id)
  where channel_id is not null;
