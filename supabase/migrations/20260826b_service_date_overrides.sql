-- 2026-08-26 — Operator Learning Router, part 2: service_date_overrides.
--
-- WHY
-- service_availability_rules (20260810) expresses recurring weekday patterns
-- ("no Sundays under 6 guests") but has no notion of a single specific date.
-- add_blackout_date expresses a full closure, not "only the private tier is
-- bookable that day" — the tour still runs, just not the shared/group rate.
-- Neither table can express "only private tours are available on September
-- 5" without either being misused (a blackout, which is wrong — the tour
-- DOES run) or falling back to business_facts prose with an expires_on,
-- which is advisory (the model has to notice and respect it) rather than
-- evaluated in code the way service_availability_rules already is.
--
-- This is the smallest structural extension that closes that gap: same
-- shape as service_availability_rules, keyed by a specific date instead of a
-- weekday, with one additional effect ('variant_only') for the
-- tier-restriction case. A row's relevance ends naturally once its date has
-- passed — no expiry bookkeeping required, the same way a calendar date
-- naturally stops mattering.
--
-- Deliberately NOT a new pricing/availability authority: it is consulted
-- ALONGSIDE service_availability_rules (a specific date's override takes
-- precedence over a general weekday rule for that same date), evaluated by
-- the same deterministic pre-LLM code path in lib/services/service-availability.ts.

create table if not exists public.service_date_overrides (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  service_id   uuid not null references public.booking_services(id) on delete cascade,

  date_iso     date not null,

  effect       text not null check (effect in ('unavailable', 'departure_minimum', 'variant_only')),

  -- 'unavailable':       does NOT apply when party >= min_party (NULL = blocked
  --                      regardless of party size), same semantics as the
  --                      recurring rule's 'unavailable' effect.
  -- 'departure_minimum': headcount needed for the tour to run this date.
  min_party    integer check (min_party is null or min_party > 0),
  constraint service_date_overrides_departure_minimum_needs_a_number
    check (effect <> 'departure_minimum' or min_party is not null),

  -- 'variant_only': only bookings for this pricing-tier variant (matching
  -- service_pricing_tiers.variant, e.g. 'private') are available this date —
  -- the tour still runs, other variants (e.g. 'shared') are not bookable.
  restricted_variant text,
  constraint service_date_overrides_variant_only_needs_a_variant
    check (effect <> 'variant_only' or restricted_variant is not null),

  note         text,
  is_active    boolean not null default true,

  -- Provenance: who/what said this. 'owner-direct' | 'operator-learning-router'
  -- (extendable — mirrors service_availability_rules.created_by's free-text
  -- convention rather than a closed enum, since this answers "why does Caye
  -- believe this" for a human reader, not a code branch).
  created_by   text not null,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists service_date_overrides_active_idx
  on public.service_date_overrides (workspace_id, service_id, date_iso)
  where is_active = true;

-- One active override per (service, date, effect) — an owner restating the
-- same date/effect updates in place rather than stacking rows that could
-- disagree. Duplicate webhook delivery of the identical correction hits this
-- constraint and is treated as an idempotent no-op by the caller.
create unique index if not exists service_date_overrides_unique_idx
  on public.service_date_overrides (workspace_id, service_id, date_iso, effect)
  where is_active = true;

alter table public.service_date_overrides enable row level security;

comment on table public.service_date_overrides is
  'Per-service, single-date availability/variant restrictions, evaluated deterministically alongside service_availability_rules in lib/services/service-availability.ts. Distinct from service_availability_rules (recurring weekday) and add_blackout_date (full closure) — the tour still runs, one specific date is restricted in scope.';
