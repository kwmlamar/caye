-- Structured prospect qualification system for Caye autonomous outreach.
-- Captures evidence-based signals, explainable scoring, and audit trail.
-- Purpose: Optimize for qualified prospects → positive replies → customers,
-- not volume. Keyed to ICP.md and decisions-log 2026-08-12 (bounded prospecting).

-- Extend outreach_leads with vertical/region/source/stage context
alter table public.outreach_leads
  add column if not exists vertical text,
  add column if not exists region text,
  add column if not exists contact_phone text,
  add column if not exists contact_whatsapp text,
  add column if not exists source text,
  add column if not exists stage text not null default 'sourced';

-- Main qualification table: structured signals, score, audit trail per prospect
create table public.prospect_qualifications (
  id uuid primary key default gen_random_uuid(),
  outreach_lead_id uuid not null unique references public.outreach_leads(id) on delete cascade,
  workspace_id uuid not null references public.customers(id) on delete cascade,
  business_vertical text not null,
  business_region text not null,
  contact_channels jsonb not null default '[]'::jsonb,
  source text not null,
  inbound_channels_observed text[],
  visible_response_slowness boolean default false,
  volume_signal text,
  catalog_stability_observed text,
  meta_access_verified boolean default false,
  personal_phone_constraint_checked boolean default false,
  personal_phone_constraint boolean,
  pain_observations text[],
  disqualifier_flags text[],
  likely_pain_category text,
  why_caye_fits text,
  qualification_score integer default 0 check (qualification_score >= 0 and qualification_score <= 100),
  score_breakdown jsonb default '{}'::jsonb,
  icp_fit_level text not null default 'unknown' check (
    icp_fit_level in ('strong', 'moderate', 'weak', 'disqualified', 'unknown')
  ),
  icp_fit_notes text,
  qualified_at timestamptz,
  disqualified_at timestamptz,
  last_assessed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint qualified_before_disqualified check (
    (qualified_at is null or disqualified_at is null) or
    (disqualified_at > qualified_at)
  ),
  unique (workspace_id, outreach_lead_id)
);

create index idx_prospect_qualifications_workspace on prospect_qualifications(workspace_id);
create index idx_prospect_qualifications_icp_fit on prospect_qualifications(icp_fit_level, created_at);
create index idx_prospect_qualifications_score on prospect_qualifications(qualification_score desc);
create index idx_prospect_qualifications_vertical_region on prospect_qualifications(business_vertical, business_region);

alter table public.prospect_qualifications enable row level security;

-- Prospect outreach pipeline: tracks which touches sent, when follow-ups due
create table public.prospect_outreach_pipeline (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null unique references public.outreach_leads(id) on delete cascade,
  first_touch_sent_at timestamptz,
  first_touch_drafted_at timestamptz,
  follow_up_1_sent_at timestamptz,
  follow_up_1_drafted_at timestamptz,
  follow_up_2_sent_at timestamptz,
  follow_up_2_drafted_at timestamptz,
  reply_received_at timestamptz,
  opted_out_at timestamptz,
  demo_tried_at timestamptz,
  next_action_due_at timestamptz,
  next_action_type text check (
    next_action_type is null or next_action_type in ('first_touch', 'follow_up_1', 'follow_up_2', 'none')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_prospect_pipeline_next_action on prospect_outreach_pipeline(next_action_due_at)
  where next_action_type is not null;
create index idx_prospect_pipeline_lead on prospect_outreach_pipeline(lead_id);

alter table public.prospect_outreach_pipeline enable row level security;

-- Evidence trail: specific observed facts that support qualification signals
create table public.outreach_signal_evidence (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.outreach_leads(id) on delete cascade,
  signal_type text not null check (
    signal_type in (
      'response_slowness', 'message_volume', 'catalog_stable',
      'meta_access', 'contact_verified', 'inbound_channel',
      'pain_articulated', 'geography_fit', 'vertical_fit'
    )
  ),
  evidence_description text not null,
  evidence_source text check (
    evidence_source in ('web_observation', 'direct_question', 'social_scan', 'referral', 'registry_data')
  ),
  evidence_url text,
  signal_weight integer default 1,
  confidence text not null default 'medium' check (confidence in ('high', 'medium', 'low')),
  created_at timestamptz not null default now()
);

create index idx_signal_evidence_lead on outreach_signal_evidence(lead_id);
create index idx_signal_evidence_type on outreach_signal_evidence(signal_type);

alter table public.outreach_signal_evidence enable row level security;

-- RLS policies
create policy "prospect_qualifications_service_role_all" on public.prospect_qualifications
  using (true) with check (true);

create policy "prospect_pipeline_service_role_all" on public.prospect_outreach_pipeline
  using (true) with check (true);

create policy "signal_evidence_service_role_all" on public.outreach_signal_evidence
  using (true) with check (true);
