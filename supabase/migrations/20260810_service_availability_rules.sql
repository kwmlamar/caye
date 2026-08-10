-- service_availability_rules (2026-08-10)
--
-- "Can this tour run, on this date, for this party?" — answered
-- deterministically instead of hoped for in prose.
--
-- WHY THIS EXISTS
-- On 2026-08-09 Mrs. Max taught Caye two constraints in one session:
--   "no sundays only if it is a group of 6 or more persons ... that is the
--    full bimini experience"
--   "they have to know that the minimum is 3 - 4 persons"
-- Both were stored as business_facts — advisory prose in the prompt. Neither
-- is expressible in caye_standing_rules either, whose triggers are a service
-- name or a literal keyword with no notion of a date or a party size. So the
-- only enforcement available for an availability rule was "the model will
-- probably remember", which is the same posture that let a per-person shared
-- rate go out as a flat solo total forty minutes after she corrected it.
--
-- The three inputs are already sitting in the intake form the vast majority
-- of Bimini's tour enquiries arrive on:
--     Tour: Full Bimini Experience
--     DateISO: 2026-06-07
--     Guests: 2
-- extractCustomerTourName / extractCustomerRequestedDate already parse two of
-- them (lib/services/match-service.ts). This table supplies the rules those
-- inputs get evaluated against.
--
-- TWO EFFECTS, BECAUSE THE OWNER TAUGHT TWO DIFFERENT THINGS
--   'unavailable'       — a hard block. The tour cannot be offered for this
--                         date/party. Optionally lifted when the party is
--                         large enough (min_party): Sunday Full Bimini is
--                         unavailable UNLESS the group is 6+.
--   'departure_minimum' — not a block. The tour can still be quoted and the
--                         spot reserved, but any quote below min_party must
--                         carry the caveat that it needs those numbers to
--                         run. Conflating this with 'unavailable' would have
--                         Caye refusing solo travellers she is supposed to
--                         be booking — Delysia Weeks was correctly quoted the
--                         shared rate with exactly this caveat.
--
-- Deliberately NOT here: per-rule customer-facing copy. The reply is still
-- written by the model in the owner's voice; this table only decides what is
-- true. Same division as caye_standing_rules, for the same reason.

CREATE TABLE service_availability_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service_id   uuid NOT NULL REFERENCES booking_services(id) ON DELETE CASCADE,

  -- 0=Sunday .. 6=Saturday, matching JS getUTCDay() and the existing
  -- owner_only_weekdays convention in lib/services/operating-rules.ts.
  -- NULL means the rule applies on every day of the week.
  weekday      smallint CHECK (weekday BETWEEN 0 AND 6),

  effect       text NOT NULL CHECK (effect IN ('unavailable', 'departure_minimum')),

  -- 'unavailable':       the rule does NOT apply when party >= min_party
  --                      (i.e. min_party is the size that lifts the block).
  --                      NULL = blocked regardless of party size.
  -- 'departure_minimum': the number needed for the tour to run. Required —
  --                      a departure minimum with no number says nothing.
  min_party    integer CHECK (min_party IS NULL OR min_party > 0),
  CONSTRAINT departure_minimum_needs_a_number
    CHECK (effect <> 'departure_minimum' OR min_party IS NOT NULL),

  -- Owner's own words where we have them. Surfaced to the model as the
  -- reason, so the customer-facing sentence sounds like the business rather
  -- than like a validation error.
  note         text,

  is_active    boolean NOT NULL DEFAULT true,

  -- Provenance, same intent as caye_standing_rules.created_by: answers "why
  -- does Caye believe this?" by pointing at who said it.
  created_by   text NOT NULL,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Loaded on the reply path for one workspace per inbound.
CREATE INDEX idx_service_availability_rules_active
  ON service_availability_rules (workspace_id, service_id)
  WHERE is_active = true;

-- One active rule per service/weekday/effect. Stops an owner restating the
-- Sunday rule from stacking two rows that could disagree about min_party.
-- COALESCE because NULL weekday ("every day") must still collide with itself.
CREATE UNIQUE INDEX idx_service_availability_rules_unique
  ON service_availability_rules (workspace_id, service_id, COALESCE(weekday, -1), effect)
  WHERE is_active = true;

-- Service-role-only, matching 20260807b_enable_rls_service_role_only_tables.sql:
-- RLS on, zero policies. Every access path goes through createServiceClient.
-- This is the intended deny-by-default end state, not an unfinished job.
ALTER TABLE service_availability_rules ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE service_availability_rules IS
  'Per-service date/party-size availability, evaluated deterministically pre-LLM in lib/services/service-availability.ts. Distinct from business_facts (advisory prose) and caye_standing_rules (no date or party awareness).';
