-- caye_standing_rules: add hard owner_only action (2026-08-18, CAY / #88)
--
-- Incident: Jonathan Garcia / Full Bimini Experience (Bimini Island Tours).
-- The owner's existing 'escalate' rule for that tour can be stood down by
-- lib/standing-rule-standdown.ts when the enquiry is fully answerable from
-- deterministic catalog/availability/pricing data. That heuristic is correct
-- for an ordinary "bring this to me" rule, but it means 'escalate' alone
-- cannot express a rule the owner needs to be genuinely non-negotiable.
--
-- 'owner_only' is that second, harder action: a match on an owner_only rule
-- is never eligible for standdown and never lets autonomous execution
-- proceed, full stop, until the owner explicitly resolves it. See
-- lib/authorize-autonomous-outbound.ts.

ALTER TABLE caye_standing_rules
  DROP CONSTRAINT caye_standing_rules_action_check;

ALTER TABLE caye_standing_rules
  ADD CONSTRAINT caye_standing_rules_action_check
  CHECK (action IN ('escalate', 'owner_only'));

COMMENT ON COLUMN caye_standing_rules.action IS
  '''escalate'' can stand down (lib/standing-rule-standdown.ts) when the enquiry is fully answerable from deterministic data. ''owner_only'' is a hard block: never stands down, always halts autonomous outbound until the owner resolves it.';
