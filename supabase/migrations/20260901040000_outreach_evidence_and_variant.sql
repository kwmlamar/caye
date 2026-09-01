-- Closes the two real gaps found in an audit of the cold-outreach pipeline
-- against the "Turn qualified Caye prospects into conversations" mission
-- brief: (1) autonomous sourcing only ever captured a contact email, never
-- any real business evidence for the first-touch HOOK beat to personalize
-- from; (2) no send was tagged with which opener framing generated it, so
-- the long-open "direct pitch vs pain-point question" opener question
-- (decisions-log 2026-07-29) could never be answered with real reply-rate
-- data, only anecdote.

alter table public.outreach_leads
  add column business_evidence text,
  add column first_touch_variant text;

comment on column public.outreach_leads.business_evidence is
  'Short excerpt (meta/og description) scraped from the prospect''s own website during sourcing (lib/outreach-sourcing.ts scrapeSite). Grounds the first-touch HOOK beat in real observed evidence instead of the model inventing detail it does not have. Null whenever no description tag was found on the site (the common case) — the draft prompt (lib/sales/voice.ts buildFirstTouchSystem) falls back to an honest, non-specific hook when this is null rather than fabricating one.';

comment on column public.outreach_leads.first_touch_variant is
  'Which first-touch opener framing (see lib/sales/voice.ts FirstTouchVariant: direct_pitch | pain_point_question) this lead''s first-touch email was generated with. Assigned deterministically from the lead id (lib/sales/voice.ts assignFirstTouchVariant) so a retried/resent draft always lands in the same bucket. Lets positive-reply-rate be compared per variant instead of only anecdotally.';
