-- Founder-only mailbox ownership for the workspace-less job-search operator.
-- Deliberately separate from connected_accounts: those rows are customer-
-- workspace resources and are consumed by front-desk discovery/reply workers.

create table if not exists public.founder_connected_accounts (
  id uuid primary key default gen_random_uuid(),
  founder_user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('zoho')),
  account_id text not null,
  email_address text not null,
  access_token text not null,
  refresh_token text,
  token_expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  needs_reauth boolean not null default false,
  last_polled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, account_id)
);

comment on table public.founder_connected_accounts is
  'Founder-personal provider grants. Never read by customer workspace discovery, unified inbox, front-desk, calendar, or reply workers. Service-role only.';

create unique index if not exists founder_connected_accounts_one_active_provider_idx
  on public.founder_connected_accounts(founder_user_id, provider)
  where is_active;

alter table public.founder_connected_accounts enable row level security;

-- One provider message may be observed by repeated cron runs, but can create
-- at most one job-search follow-up.
create unique index if not exists job_search_followups_source_email_ref_idx
  on public.job_search_followups(source_email_ref)
  where source_email_ref is not null;
