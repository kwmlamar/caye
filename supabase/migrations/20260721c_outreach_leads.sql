-- Step 1 of the outreach autonomy roadmap (decisions-log 2026-07-21,
-- "Caye outreach: staged autonomy roadmap"): before Caye can autonomously
-- send follow-up nudges to warm leads, lead/send state needs to live
-- somewhere queryable — today it's only in outreach/log.md and the leads
-- spreadsheet, both plain files a cron can't reliably read.
--
-- Reply detection deliberately does NOT get its own column here. The
-- internal_sales workspace (hello@getcaye.com) already runs through the
-- normal Zoho/Gmail poll pipeline (app/api/webhooks/zoho-email,
-- app/api/email/gmail-poll), so any reply from a lead already lands in
-- unified_conversations/unified_messages keyed by customer_id = the
-- lead's email. "Has this lead replied?" is computed at read time by
-- joining on lead_email — one join, not a second source of truth that
-- can drift from what actually happened in the inbox.
create table public.outreach_leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  lead_email text not null,
  business_name text,
  contact_name text,
  first_touch_sent_at timestamptz,
  nudge_count integer not null default 0,
  last_nudge_at timestamptz,
  -- Hard stop the nudge cron must check before sending anything, separate
  -- from reply detection: covers explicit "not interested"/unsubscribe
  -- replies and any lead Lamar marks off-limits by hand. Reply detection
  -- alone doesn't cover a lead who was contacted off-platform (phone/DM)
  -- and asked to stop there.
  opted_out_at timestamptz,
  status text not null default 'sent',
  created_at timestamptz not null default now(),
  unique (workspace_id, lead_email)
);

comment on table public.outreach_leads is
  'Per-lead send state for TropiTech''s own cold-outreach workspace (internal_sales). Backs the autonomous follow-up-nudge step of the outreach autonomy roadmap (decisions-log 2026-07-21) — reply detection joins against unified_conversations/unified_messages by lead_email rather than duplicating reply state here.';
comment on column public.outreach_leads.status is
  'sent | replied | converted | cold | do_not_contact — mirrors outreach/log.md''s existing status vocabulary so the two stay legible against each other during the manual-to-automated transition.';
comment on column public.outreach_leads.opted_out_at is
  'Hard stop checked by the nudge cron before any autonomous send. Set on explicit decline/unsubscribe or manual founder override — independent of reply detection, which only covers replies that land in this workspace''s inbox.';
