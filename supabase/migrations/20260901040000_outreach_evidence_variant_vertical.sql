alter table public.outreach_leads
  add column business_evidence text,
  add column first_touch_variant text,
  add column outreach_vertical text;

alter table public.outreach_leads
  add constraint outreach_leads_first_touch_variant_check
  check (first_touch_variant is null or first_touch_variant in ('direct_pitch', 'pain_point_question'));

comment on column public.outreach_leads.business_evidence is
  'Short first-party description from the prospect website. Describes what the business says it does; it is not evidence of operational pain.';
comment on column public.outreach_leads.first_touch_variant is
  'Deterministic first-touch experiment bucket used for outcome attribution.';
comment on column public.outreach_leads.outreach_vertical is
  'Canonical sourcing-target vertical captured when the lead is inserted, for funnel reporting by vertical.';
