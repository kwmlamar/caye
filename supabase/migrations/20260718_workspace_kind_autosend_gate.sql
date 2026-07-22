-- Issue #66: TropiTech's own workspace (hello@getcaye.com, cold-outreach
-- reply drafting) needs the reply engine to behave differently from a
-- tour-operator workspace in two orthogonal ways:
--   - workspace_kind: which tool list / system prompt frame to use
--     (booking-shaped 'service_business' vs. 'internal_sales' with no
--     booking/pricing/calendar concept at all)
--   - autosend_enabled: whether generateCayeAutoReply is allowed to ship
--     anything without a human in the loop
-- Kept as two separate columns rather than overloading one flag — a future
-- cautious *service* pilot could want autosend disabled without losing its
-- booking tools.

alter table public.customers
  add column workspace_kind text not null default 'service_business';

alter table public.customers
  add column autosend_enabled boolean not null default true;

comment on column public.customers.workspace_kind is
  'Selects which tool list / system-prompt frame generateCayeAutoReply uses. service_business = existing booking/receptionist behavior. internal_sales = TropiTech''s own cold-outreach reply drafting (issue #66): no booking/pricing/calendar tools, sales-reply framing.';

comment on column public.customers.autosend_enabled is
  'When false, lib/autosend-gate.ts forces every generateCayeAutoReply decision to hold instead of sending or escalating, and strips hold customerAcknowledgement. Code-enforced, not prompt-only — see issue #66.';
