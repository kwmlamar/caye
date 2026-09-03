-- Bounce detail + suppression columns for caye_outreach_bounces
-- (20260812b_outreach_bounce_log). Deliverability incident 2026-09-03:
-- autonomous cold outreach from hello@getcaye.com was running a 10%+
-- bounce rate (industry danger line is 2-3%) and the table could only
-- count bounces, not say which address bounced or how badly. Nothing
-- downstream could act on it: no suppression list (dead addresses kept
-- receiving the 3-touch follow-up cadence — 251 follow-ups against 104
-- first touches since 2026-08-12), no hard/soft distinction (an
-- out-of-office-adjacent transient bounce counted the same as a dead
-- domain toward the kill-switch threshold), no way to audit a
-- misclassification after the fact.
--
-- Purely additive. All three new columns are nullable/defaulted so the
-- existing 25 rows (tracking began 2026-08-14) survive untouched, and the
-- kill switch's existing "count bounces in the trailing window" shape of
-- query keeps working — lib/outreach-kill-switch.ts now selects
-- `classification` instead of doing a head-only count, and treats a NULL/
-- 'unknown' classification the same conservative way for both new
-- unclassifiable bounces and this historical backfill-free data.

alter table public.caye_outreach_bounces
  add column bounced_recipient text,
  add column classification text not null default 'unknown',
  add column source_subject text;

alter table public.caye_outreach_bounces
  add constraint caye_outreach_bounces_classification_check
  check (classification in ('hard', 'soft', 'unknown'));

comment on column public.caye_outreach_bounces.bounced_recipient is
  'Lowercased address the DSN/NDR reports as failed (lib/sender-classifier.ts''s extractBouncedRecipient: Final-Recipient/Original-Recipient/X-Failed-Recipients headers, falling back to a bounded body scan). NULL when extraction could not confirm an address -- recorded honestly as unattributed rather than guessed, and also NULL on every pre-migration historical row. lib/outreach-suppression.ts only suppresses a lead when this is non-null and matches its email.';

comment on column public.caye_outreach_bounces.classification is
  'hard = address is dead (5.x.x / unknown user / no such mailbox -- lib/outreach-suppression.ts suppresses on the first one), soft = transient (4.x.x / mailbox full / greylisted -- bounded retries tolerated before suppression), unknown = bounce detected by subject but the body did not match either pattern confidently. Defaults to unknown, which is also what every pre-migration row reads as -- the conservative choice in both the kill switch (weighted like hard, since we can''t prove it wasn''t) and suppression (never attributed to an address on its own).';

comment on column public.caye_outreach_bounces.source_subject is
  'Subject line of the bounce/NDR email, truncated by the caller before insert. Kept only so a suspected misclassification can be audited later without re-querying the mail provider -- not used in any query.';

create index caye_outreach_bounces_workspace_recipient_idx
  on public.caye_outreach_bounces (workspace_id, bounced_recipient)
  where bounced_recipient is not null;
