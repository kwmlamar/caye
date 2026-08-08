-- caye_standing_rules (2026-08-08)
--
-- Owner-taught constraints that are ENFORCED rather than suggested. See
-- briefs/standing-rules-plan.md for the full diagnosis.
--
-- The split this table exists to make real:
--   business_facts  = knowledge. Prose in the reply prompt. Advisory —
--                     the model may paraphrase, deprioritise, or ignore it.
--   standing rules  = constraints on Caye's own authority. Evaluated
--                     deterministically BEFORE the model runs, so there is
--                     no opportunity to disobey.
--
-- Why not extend the existing `standing_rules` table: it stores free-text
-- `rule_text`, which reproduces exactly the advisory-prose problem this is
-- meant to fix. It has zero rows, so nothing needs migrating; it is left
-- untouched here and should be dropped once lib/data/mobile.ts stops
-- referencing it.
--
-- Deliberately narrow for v1 (one action, two trigger types, no per-rule
-- customer template). Every constraint Karenda has actually asked for
-- reduces to "bring it to me" — see the brief's §3 for why each field was
-- kept out.

CREATE TABLE caye_standing_rules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- 'service_mention' matches a catalog service name (validated against
  -- booking_services at write time, so a typo can't create a dead rule).
  -- 'keyword' matches a literal phrase, case-insensitively. No regex:
  -- an LLM-authored pattern eventually matches everything or nothing.
  trigger_type      text NOT NULL CHECK (trigger_type IN ('service_mention', 'keyword')),
  match_value       text NOT NULL CHECK (length(btrim(match_value)) >= 3),

  -- v1 has exactly one action. Kept as a column (not implied) so adding
  -- 'require_deposit_terms' or similar later doesn't need a table rewrite.
  action            text NOT NULL DEFAULT 'escalate' CHECK (action IN ('escalate')),
  route_to          text NOT NULL DEFAULT 'owner' CHECK (route_to IN ('owner', 'founder', 'both')),

  is_active         boolean NOT NULL DEFAULT true,

  -- Staleness signal. A rule that has never fired in 90 days is probably
  -- wrong or obsolete; these columns exist from day one so the data is
  -- there when that review is built (brief §5.4).
  times_fired       integer NOT NULL DEFAULT 0,
  last_fired_at     timestamptz,

  -- Provenance: answers "why does Caye do this?" by pointing at the
  -- WhatsApp message where the owner said it.
  created_by        text NOT NULL,
  source_message_id text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The reply path loads active rules for one workspace on every inbound,
-- so this index is on the hot path.
CREATE INDEX idx_caye_standing_rules_active
  ON caye_standing_rules (workspace_id)
  WHERE is_active = true;

-- One rule per trigger+value per workspace. Prevents an owner restating
-- the same constraint from silently stacking duplicate escalations.
CREATE UNIQUE INDEX idx_caye_standing_rules_unique_match
  ON caye_standing_rules (workspace_id, trigger_type, lower(btrim(match_value)))
  WHERE is_active = true;

-- Service-role-only, matching the posture set in
-- 20260807b_enable_rls_service_role_only_tables.sql: RLS on, zero policies.
-- Every access path goes through createServiceClient, which bypasses RLS;
-- anon/authenticated access is deliberately zero. This is the intended
-- deny-by-default end state, not an unfinished job.
ALTER TABLE caye_standing_rules ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE caye_standing_rules IS
  'Owner-taught constraints enforced deterministically pre-LLM in lib/caye-reply.ts. Distinct from business_facts, which are advisory prose in the prompt. See briefs/standing-rules-plan.md.';
