-- 2026-07-26 — Pricing tier variant axis + provenance, Bimini re-price
--
-- BACKGROUND: service_pricing_tiers (20260530) resolves price on a single
-- axis — group_size. Karenda's 2026-07-23 confirmed pricing call (see
-- Clients/bimini-island-tours.md#4-pulse) introduced tours where the SAME
-- group size legitimately has two prices — e.g. North Bimini Heritage Tour
-- at 1 guest is $110 (Standard/shared) or $200 (Private). group_size alone
-- can no longer determine price for these tours; resolveTier would either
-- silently pick the wrong one or hold every quote forever depending on how
-- it's loaded. See lib/services/resolve-tier.ts (2026-07-26 revision) for
-- the matching logic this schema supports.
--
-- CHANGES:
--   1. `variant` — machine-stable second axis (e.g. 'standard', 'private').
--      Null for the vast majority of existing tours where group_size alone
--      is unambiguous — fully backward compatible, no re-seed needed there.
--   2. `source` / `confirmed_at` — provenance. The Bimini pricing-audit
--      (Clients/bimini-island-tours/pricing-audit.md) exists because nobody
--      could tell which of three disagreeing sources (catalog, prose config,
--      Karenda's actual sent quotes) was current. Every future tier write
--      records where it came from and when an owner last confirmed it.
--   3. Re-seed Full Bimini Experience + North Bimini Heritage Tour to
--      Karenda's 2026-07-23 confirmed structure (owner_confirmed).
--      South Bimini / Eat Like a Local / Sit-Low / Golf Cart are untouched —
--      not part of that confirmation round (STATE.md still lists their
--      Sit-Low/Eat-Like-a-Local discrepancy as open).

ALTER TABLE service_pricing_tiers
  ADD COLUMN IF NOT EXISTS variant TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'seed',
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

COMMENT ON COLUMN service_pricing_tiers.variant IS
  'Machine-stable key for the second pricing axis (e.g. ''standard'', ''private''). Null when group_size alone determines price. Distinct from tier_name (human label) so wording can change without breaking resolution — see resolveTier in lib/services/resolve-tier.ts.';

COMMENT ON COLUMN service_pricing_tiers.source IS
  'Provenance of this row: ''seed'' (initial website-derived seed, unverified), ''owner_confirmed'' (owner stated this price directly), ''owner_quote_mined'' (extracted from the owner''s own sent quotes), ''website_import'' (scraped at onboarding, unconfirmed).';

COMMENT ON COLUMN service_pricing_tiers.confirmed_at IS
  'When an owner last confirmed this exact price, if ever. Null for seed/unconfirmed rows.';

-- ── Full Bimini Experience — Karenda 2026-07-23 confirmed pricing ────────
-- service_id b1a475c1-90ce-45d2-a6c0-095c7e0969f4, workspace
-- 653257d9-c0f1-4271-be6d-3e2596fd893e
--
-- Old structure (Adult/Private-2-flat/Group-4+) replaced with:
--   Shared: $199/person, any group size — always bookable.
--   Private Couple (2): $450 flat (was $475).
--   Private Family (3-6): $215/person — new tier, closes the old
--     group-of-3 gap (pricing-audit.md Q6).
--   Private Group (7+): $225/person (threshold moves from 4+ to 7+).
DELETE FROM service_pricing_tiers WHERE service_id = 'b1a475c1-90ce-45d2-a6c0-095c7e0969f4';

INSERT INTO service_pricing_tiers
  (workspace_id, service_id, tier_name, variant, group_size_min, group_size_max, price_amount, price_label, is_flat, display_order, source, confirmed_at)
VALUES
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', 'b1a475c1-90ce-45d2-a6c0-095c7e0969f4', 'Shared', 'shared', 1, 50, 199, '$199/person', false, 10, 'owner_confirmed', '2026-07-23'),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', 'b1a475c1-90ce-45d2-a6c0-095c7e0969f4', 'Private Couple (2)', 'private', 2, 2, 450, '$450 total', true, 20, 'owner_confirmed', '2026-07-23'),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', 'b1a475c1-90ce-45d2-a6c0-095c7e0969f4', 'Private Family (3-6)', 'private', 3, 6, 215, '$215/person', false, 30, 'owner_confirmed', '2026-07-23'),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', 'b1a475c1-90ce-45d2-a6c0-095c7e0969f4', 'Private Group (7+)', 'private', 7, 50, 225, '$225/person', false, 40, 'owner_confirmed', '2026-07-23');

-- ── North Bimini Heritage Tour — Karenda 2026-07-23 confirmed pricing ────
-- service_id 4c37b2c9-5fc5-4940-8ff0-f653257d8618
--
-- Old structure (Adult/Private-2-flat/Group-4+) replaced with a full
-- Standard-vs-Private split at every group size:
--   1 guest:  Standard $110/person   | Private $200 flat
--   2 guests: Standard $220 flat     | Private $350 flat
--   3+ guests: Standard $110/person  | Private $150/person
DELETE FROM service_pricing_tiers WHERE service_id = '4c37b2c9-5fc5-4940-8ff0-f653257d8618';

INSERT INTO service_pricing_tiers
  (workspace_id, service_id, tier_name, variant, group_size_min, group_size_max, price_amount, price_label, is_flat, display_order, source, confirmed_at)
VALUES
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', '4c37b2c9-5fc5-4940-8ff0-f653257d8618', 'Standard (1 Guest)', 'standard', 1, 1, 110, '$110/person', false, 10, 'owner_confirmed', '2026-07-23'),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', '4c37b2c9-5fc5-4940-8ff0-f653257d8618', 'Private (1 Guest)', 'private', 1, 1, 200, '$200 flat', true, 20, 'owner_confirmed', '2026-07-23'),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', '4c37b2c9-5fc5-4940-8ff0-f653257d8618', 'Standard (2 Guests)', 'standard', 2, 2, 220, '$220 total', true, 30, 'owner_confirmed', '2026-07-23'),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', '4c37b2c9-5fc5-4940-8ff0-f653257d8618', 'Private (2 Guests)', 'private', 2, 2, 350, '$350 total', true, 40, 'owner_confirmed', '2026-07-23'),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', '4c37b2c9-5fc5-4940-8ff0-f653257d8618', 'Standard (3+ Guests)', 'standard', 3, 50, 110, '$110/person', false, 50, 'owner_confirmed', '2026-07-23'),
  ('653257d9-c0f1-4271-be6d-3e2596fd893e', '4c37b2c9-5fc5-4940-8ff0-f653257d8618', 'Private (3+ Guests)', 'private', 3, 50, 150, '$150/person', false, 60, 'owner_confirmed', '2026-07-23');
