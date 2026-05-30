-- 2026-05-30 — Deterministic per-tour pricing tiers
--
-- BACKGROUND: The Stallings 2026-05-29 case (see Clients/bimini-island-tours.md
-- and _Ops/Brain/decisions-log.md) showed that LLM-paraphrased pricing from a
-- text blob (workspace_ai_config.pricing_info) is unreliable. A human typed
-- $150/person for a 2-person Private tour where the actual rate is $375 flat;
-- the same tier confusion happens to an LLM. Karenda explicitly asked for
-- "Caye handles everything" — autonomous mode — which means pricing must be
-- deterministic, not generated.
--
-- DESIGN: Per-tour, per-tier rows. Caye's reply path calls resolveTier(
-- service_id, group_size) → returns the exact tier with price + label.
-- LLM only receives the resolved price string to drop into the email; it
-- never paraphrases pricing math.
--
-- TIER MATCHING RULES (implemented in lib/services/resolve-tier.ts):
--   - group_size in [tier.group_size_min, tier.group_size_max] → matched tier
--   - No matching tier → hold for owner review
--   - Multiple matching tiers → hold (ambiguous tier definitions)
--   - is_ambiguous_above=true tiers: when group_size > group_size_max and the
--     next tier doesn't pick up at group_size_max+1, hold rather than guess
--   - is_flat tiers: price is the whole-party total (e.g. "$375 flat for 2")
--   - non-flat: price is per-person, total = price × group_size
--
-- "STARTING AT $X" TIERS: stored as is_ambiguous_above=true with a low
-- group_size_max — resolves the obvious cases, holds for anything bigger.

CREATE TABLE IF NOT EXISTS service_pricing_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES booking_services(id) ON DELETE CASCADE,
  tier_name TEXT NOT NULL,
  group_size_min INTEGER NOT NULL CHECK (group_size_min >= 1),
  group_size_max INTEGER NOT NULL CHECK (group_size_max >= group_size_min),
  price_amount NUMERIC(10, 2) NOT NULL CHECK (price_amount >= 0),
  price_label TEXT NOT NULL,
  is_flat BOOLEAN NOT NULL DEFAULT false,
  is_ambiguous_above BOOLEAN NOT NULL DEFAULT false,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_pricing_tiers_service
  ON service_pricing_tiers(service_id);

CREATE INDEX IF NOT EXISTS idx_service_pricing_tiers_workspace
  ON service_pricing_tiers(workspace_id);

COMMENT ON TABLE service_pricing_tiers IS
  'Per-tour pricing tiers. Caye uses these for deterministic price resolution rather than paraphrasing workspace_ai_config.pricing_info. See _Ops/Brain/decisions-log.md 2026-05-30 for the autonomy/pricing decision.';

COMMENT ON COLUMN service_pricing_tiers.is_flat IS
  'true = price_amount is the whole-party total (e.g. "Private 2-max $375 flat"). false = price_amount is per-person, multiplied by group size.';

COMMENT ON COLUMN service_pricing_tiers.is_ambiguous_above IS
  'true = if the customer''s group size is above group_size_max and the next tier does not pick up, hold for review (do not extrapolate). Used for "starting at $X" pricing shapes where the upper bound is not well-defined.';

-- RLS: workspace members only (mirrors booking_services pattern)
ALTER TABLE service_pricing_tiers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read own workspace tiers"
  ON service_pricing_tiers FOR SELECT
  USING (
    workspace_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = service_pricing_tiers.workspace_id
        AND workspace_members.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner writes own workspace tiers"
  ON service_pricing_tiers FOR ALL
  USING (workspace_id = auth.uid())
  WITH CHECK (workspace_id = auth.uid());

-- ── SEED: Bimini Island Tours pricing ─────────────────────────────────────
-- Source: tourbimini.com/tours.html (verified live 2026-05-30 via WebFetch).
-- Workspace: 653257d9-c0f1-4271-be6d-3e2596fd893e
--
-- Tier conventions per tour:
--   1. Adults — base per-person rate, any group size 1+, BUT shadowed by
--      Private tiers when group_size is in their range (rows have explicit
--      group_size_min/max to scope correctly)
--   2. Private (2 max) — flat fee, exactly 2 people
--   3. Private Group (min 4) — per-person, 4+ people
--   4. Gap at group_size=3 is intentional — resolveTier holds for that case
--      (ambiguous between Private 2-max and Private Group 4-min).
--
-- Note: Children pricing (under 12 etc.) is NOT modeled here — children
-- pricing requires age info we don't reliably extract from inquiries.
-- Caye holds when a customer mentions children until we add that layer.

-- 1. Full Bimini Experience — service_id b1a475c1-90ce-45d2-a6c0-095c7e0969f4
INSERT INTO service_pricing_tiers (workspace_id, service_id, tier_name, group_size_min, group_size_max, price_amount, price_label, is_flat, display_order)
VALUES
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', 'b1a475c1-90ce-45d2-a6c0-095c7e0969f4', 'Adult', 1, 1, 199, '$199/person', false, 10),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', 'b1a475c1-90ce-45d2-a6c0-095c7e0969f4', 'Private (2 max)', 2, 2, 475, '$475 flat (2 people max)', true, 20),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', 'b1a475c1-90ce-45d2-a6c0-095c7e0969f4', 'Private Group (min 4)', 4, 50, 225, '$225/person', false, 30);

-- 2. South Bimini: Ponce de León Tour — efac7fed-7c33-4519-aa16-1d4e7fb0b358
INSERT INTO service_pricing_tiers (workspace_id, service_id, tier_name, group_size_min, group_size_max, price_amount, price_label, is_flat, display_order)
VALUES
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', 'efac7fed-7c33-4519-aa16-1d4e7fb0b358', 'Adult', 1, 1, 150, '$150/person', false, 10),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', 'efac7fed-7c33-4519-aa16-1d4e7fb0b358', 'Private (2 max)', 2, 2, 425, '$425 flat (2 people max)', true, 20),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', 'efac7fed-7c33-4519-aa16-1d4e7fb0b358', 'Private Group (min 4)', 4, 50, 170, '$170/person', false, 30);

-- 3. North Bimini Heritage Tour — 4c37b2c9-5fc5-4940-8ff0-f653257d8618
-- THIS IS THE TOUR THAT BROKE STALLINGS.
INSERT INTO service_pricing_tiers (workspace_id, service_id, tier_name, group_size_min, group_size_max, price_amount, price_label, is_flat, display_order)
VALUES
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', '4c37b2c9-5fc5-4940-8ff0-f653257d8618', 'Adult', 1, 1, 110, '$110/person', false, 10),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', '4c37b2c9-5fc5-4940-8ff0-f653257d8618', 'Private (2 max)', 2, 2, 375, '$375 flat (2 people max)', true, 20),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', '4c37b2c9-5fc5-4940-8ff0-f653257d8618', 'Private Group (min 4)', 4, 50, 150, '$150/person', false, 30);

-- 4. Eat Like a Local — bc7aab2d-7090-4c9c-a813-34c66686228a
INSERT INTO service_pricing_tiers (workspace_id, service_id, tier_name, group_size_min, group_size_max, price_amount, price_label, is_flat, display_order)
VALUES
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', 'bc7aab2d-7090-4c9c-a813-34c66686228a', 'Adult', 1, 1, 175, '$175/person', false, 10),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', 'bc7aab2d-7090-4c9c-a813-34c66686228a', 'Private (2 max)', 2, 2, 450, '$450 flat (2 people max)', true, 20),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', 'bc7aab2d-7090-4c9c-a813-34c66686228a', 'Private Group (min 4)', 4, 50, 190, '$190/person', false, 30);

-- 5. Bimini Sit-Low Sightseeing — 21a02817-631a-4cf6-abba-a88dd2468703
INSERT INTO service_pricing_tiers (workspace_id, service_id, tier_name, group_size_min, group_size_max, price_amount, price_label, is_flat, display_order)
VALUES
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', '21a02817-631a-4cf6-abba-a88dd2468703', 'Adult', 1, 1, 60, '$60/person', false, 10),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', '21a02817-631a-4cf6-abba-a88dd2468703', 'Private (2 max)', 2, 2, 150, '$150 flat (2 people max)', true, 20),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', '21a02817-631a-4cf6-abba-a88dd2468703', 'Private Group (min 4)', 4, 50, 75, '$75/person', false, 30);

-- 6. Golf Cart Guided Tour — 93648097-b79c-4b1f-ad75-056b5b7f39ff
-- "Starting at $350" — ambiguous shape. Resolves only for small groups.
-- Anything > 4 holds for owner review.
INSERT INTO service_pricing_tiers (workspace_id, service_id, tier_name, group_size_min, group_size_max, price_amount, price_label, is_flat, is_ambiguous_above, display_order)
VALUES
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', '93648097-b79c-4b1f-ad75-056b5b7f39ff', 'Orientation (1hr)', 1, 4, 199, 'Starting at $199 (1-hour orientation)', true, true, 10),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', '93648097-b79c-4b1f-ad75-056b5b7f39ff', 'Fully Guided (2hr)', 1, 4, 350, 'Starting at $350 (2-hour fully guided)', true, true, 20);
