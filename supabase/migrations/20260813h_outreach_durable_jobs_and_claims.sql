alter table public.caye_pending_operations
  drop constraint if exists caye_pending_operations_status_check;
alter table public.caye_pending_operations
  add constraint caye_pending_operations_status_check
  check (status in ('pending', 'processing', 'synced', 'failed', 'dead_letter', 'cancelled'));
alter table public.caye_pending_operations
  add column if not exists claimed_at timestamptz,
  add column if not exists claim_token uuid;
create index if not exists caye_pending_operations_stale_claim_idx
  on public.caye_pending_operations (claimed_at)
  where status = 'processing';

alter table public.outreach_leads
  add column if not exists outreach_claim_token uuid,
  add column if not exists outreach_claimed_at timestamptz;
create index if not exists outreach_leads_claim_idx
  on public.outreach_leads (workspace_id, outreach_claimed_at)
  where outreach_claim_token is not null;

comment on column public.caye_pending_operations.claim_token is
  'Compare-and-set worker lease. Prevents overlapping workers from executing one operation twice.';
comment on column public.outreach_leads.outreach_claim_token is
  'Autosend execution claim. A stale claim is surfaced for review, never automatically resent after an ambiguous provider outcome.';
