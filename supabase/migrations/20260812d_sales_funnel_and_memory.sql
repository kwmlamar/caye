-- Caye as an autonomous salesperson rather than a message scheduler.
-- Companion to lib/sales/*. Three problems this fixes:
--
-- 1. NO FUNNEL. outreach_leads.status mixed relationship state ('sent',
--    'replied'), artefact state ('draft'), and stop-reason ('cold') in one
--    column with no constraint, and the two values that would have meant
--    success -- 'replied' and 'converted' -- were never written by any code.
--    `stage` is now one question: where is this relationship. Vocabulary is
--    owned by lib/sales/funnel.ts and asserted against this constraint by
--    funnel.test.ts, so adding a stage in code without a migration fails the
--    suite instead of hitting a constraint violation in production at 3am.
--
-- 2. SENT vs ATTEMPTED. last_nudge_at was stamped on every attempted touch,
--    sent or held. The daily cap and the morning digest both read it, so
--    held drafts were counted as sends: the cap over-throttled (safe
--    direction) and the digest over-reported (not safe -- it told Lamar work
--    happened that did not). Splitting the two makes each number mean one
--    thing.
--
-- 3. NO MEMORY. Nothing recorded what a prospect said, objected to, or
--    asked, so every reply started cold and "this objection came up five
--    times" was unanswerable. sales_lead_signals is that record.

alter table public.outreach_leads
  add column stage text not null default 'sourced',
  add column qualified_at timestamptz,
  add column disqualified_reason text,
  -- Touches actually DELIVERED. last_nudge_at keeps its existing meaning of
  -- "last attempt" for back-compat with the send-limit query, but every new
  -- read of "did we actually contact them" uses these.
  add column touches_sent integer not null default 0,
  add column last_touch_sent_at timestamptz;

alter table public.outreach_leads
  add constraint outreach_leads_stage_check check (stage in (
    'sourced','contacted','engaged','qualified','demo_started','activated','won','lost','disqualified'
  ));

comment on column public.outreach_leads.stage is
  'Where this relationship is, and nothing else. Vocabulary owned by lib/sales/funnel.ts (SALES_STAGES); this constraint is asserted against that array by funnel.test.ts. Artefact state lives on the conversation; why we stopped lives in disqualified_reason.';
comment on column public.outreach_leads.touches_sent is
  'Outbound touches actually delivered, including the first. Distinct from nudge_count, which counts attempts (including drafts held for review) and therefore cannot be used to decide what to send next.';

-- Backfill stage from the existing status vocabulary. Deliberately
-- conservative: anything ambiguous lands on the earliest defensible stage
-- rather than overstating progress, since overstating it would suppress
-- follow-ups to people who never actually heard from us.
update public.outreach_leads set stage =
  case
    when opted_out_at is not null then 'disqualified'
    when status = 'tried' then 'demo_started'
    when status = 'converted' then 'won'
    when status = 'cold' then 'lost'
    when status = 'do_not_contact' then 'disqualified'
    when status = 'replied' then 'engaged'
    when first_touch_sent_at is not null then 'contacted'
    else 'sourced'
  end;

-- Best available reconstruction: a lead with a first touch had at least one
-- delivered touch, plus however many nudges were attempted. Slightly
-- overstates for leads whose nudges were held, which is the safe direction
-- (it under-sends rather than double-sending someone).
update public.outreach_leads
  set touches_sent = 1 + coalesce(nudge_count, 0),
      last_touch_sent_at = coalesce(last_nudge_at, first_touch_sent_at)
  where first_touch_sent_at is not null;

create table public.sales_lead_signals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  lead_id uuid not null references public.outreach_leads(id) on delete cascade,
  -- objection      : a reason they gave for not buying
  -- question       : something they asked that we should be able to answer
  -- intent         : a buying signal
  -- disqualifier   : an ICP mismatch we detected
  -- escalation     : we handed this to the founder, with the category
  -- outcome        : an action Caye took and how it went
  kind text not null check (kind in ('objection','question','intent','disqualifier','escalation','outcome')),
  -- Short normalised label, e.g. 'price_too_high'. Grouped for reporting,
  -- so it must stay low-cardinality; the free text goes in `detail`.
  label text not null,
  detail text,
  created_at timestamptz not null default now()
);

create index sales_lead_signals_lead_idx on public.sales_lead_signals (lead_id, created_at desc);
create index sales_lead_signals_workspace_kind_idx on public.sales_lead_signals (workspace_id, kind, label);

comment on table public.sales_lead_signals is
  'What Caye learned, per lead. Two jobs: per-lead memory so a reply knows what was already said, and cross-lead aggregation (group by label) so recurring objections become visible in the digest instead of being rediscovered one prospect at a time.';

alter table public.sales_lead_signals enable row level security;
