-- increment_standing_rule_fired (2026-08-08)
--
-- Atomic usage counter for caye_standing_rules. A plain read-modify-write
-- from the reply path would lose increments whenever two inbound messages
-- match the same rule concurrently — which is exactly the busy-workspace
-- case where the staleness signal (brief §5.4) matters most.
--
-- SECURITY DEFINER so the counter still advances if the calling role ever
-- changes, but EXECUTE is revoked from anon/authenticated below: only the
-- service role reaches this, matching the deny-by-default posture in
-- 20260807b and the revoke applied to the workspace_events RPC in 20260807f.

CREATE OR REPLACE FUNCTION increment_standing_rule_fired(rule_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE caye_standing_rules
  SET times_fired = times_fired + 1,
      last_fired_at = now(),
      updated_at = now()
  WHERE id = rule_id;
$$;

REVOKE ALL ON FUNCTION increment_standing_rule_fired(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION increment_standing_rule_fired(uuid) FROM anon;
REVOKE ALL ON FUNCTION increment_standing_rule_fired(uuid) FROM authenticated;
