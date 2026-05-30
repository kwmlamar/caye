-- 2026-05-30 — Extend booking_services as canonical tour catalog
--
-- BACKGROUND: booking_services is the existing-but-empty table that BACKLOG.md
-- describes as the planned canonical tour catalog. Today (per the Stallings
-- post-mortem and Karenda's "Caye handles everything" directive) we start
-- using it: one row per tour, with all tour-level metadata co-located.
--
-- Adds three columns:
--   slug          — kebab-case tour identifier, matches email_templates.tour_type_slug
--   payment_link  — WeTravel URL Caye drops into confirmation emails
--   metadata      — JSONB overflow bucket for unanticipated tour-level config
--                   (per Lamar's "Caye routes data into appropriate tables;
--                   if no fit, use metadata or ask Lamar to extend" design)
--
-- Unique constraint on (user_id, slug) so Caye / migrations can upsert by slug.
-- service_pricing_tiers (next migration) will FK against booking_services.id.

ALTER TABLE booking_services
  ADD COLUMN IF NOT EXISTS slug TEXT,
  ADD COLUMN IF NOT EXISTS payment_link TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_services_user_slug
  ON booking_services(user_id, slug)
  WHERE slug IS NOT NULL;

COMMENT ON COLUMN booking_services.slug IS
  'Kebab-case identifier matching email_templates.tour_type_slug. Used to join templates, pricing tiers, and bookings.tour_type_slug to the canonical service row.';
COMMENT ON COLUMN booking_services.payment_link IS
  'External payment URL (e.g. WeTravel) Caye includes in post-confirmation emails. Null if not yet configured.';
COMMENT ON COLUMN booking_services.metadata IS
  'JSONB overflow for tour-specific config that does not yet warrant a typed column (e.g. {"cancellation_hours": 24, "deposit_required": false}). Promote to typed columns when patterns recur across workspaces.';

-- Seed 6 Bimini Island Tours rows. Mirrors email_templates slug+name+duration.
-- workspace_id: 653257d9-c0f1-4271-be6d-3e2596fd893e (Bimini Island Tours)
-- max_capacity: defaulting to 10; Karenda can adjust later via Settings UI.
-- payment_link: NULL until Karenda sends WeTravel links.

INSERT INTO booking_services (user_id, name, slug, description, duration_minutes, max_capacity, price_type, color, active, metadata)
VALUES
  ('653257d9-c0f1-4271-be6d-3e2596fd893e',
   'Full Bimini Experience',
   'full-bimini-experience',
   'Four-hour journey covering the best of North and South Bimini — Dolphin House, Fountain of Youth, and more.',
   240, 10, 'per_person', '#3A9B9F', true,
   '{"seed_source": "2026-05-30 migration from email_templates + tourbimini.com"}'::jsonb),

  ('653257d9-c0f1-4271-be6d-3e2596fd893e',
   'South Bimini: Ponce de León Tour',
   'south-bimini-tour',
   'Two-hour South Bimini tour — Fountain of Youth, Shell Beach, Bimini Biological Shark Lab.',
   120, 10, 'per_person', '#3A9B9F', true,
   '{"seed_source": "2026-05-30 migration from email_templates + tourbimini.com"}'::jsonb),

  ('653257d9-c0f1-4271-be6d-3e2596fd893e',
   'North Bimini Heritage Tour',
   'north-bimini-historical-tour',
   'Two-hour journey through North Bimini history, culture, and landmarks. Includes live conch demonstration.',
   120, 10, 'per_person', '#3A9B9F', true,
   '{"seed_source": "2026-05-30 migration from email_templates + tourbimini.com"}'::jsonb),

  ('653257d9-c0f1-4271-be6d-3e2596fd893e',
   'Eat Like a Local',
   'eat-like-a-local',
   'Three-hour culinary deep-dive into Bimini — fresh conch, island bread, local specialties.',
   180, 10, 'per_person', '#3A9B9F', true,
   '{"seed_source": "2026-05-30 migration from email_templates + tourbimini.com"}'::jsonb),

  ('653257d9-c0f1-4271-be6d-3e2596fd893e',
   'Bimini Sit-Low Sightseeing',
   'bimini-sit-low-sightseeing',
   'One-hour island orientation pass — Bimini''s landmarks for guests on a tight schedule.',
   60, 10, 'per_person', '#3A9B9F', true,
   '{"seed_source": "2026-05-30 migration from email_templates + tourbimini.com"}'::jsonb),

  ('653257d9-c0f1-4271-be6d-3e2596fd893e',
   'Golf Cart Guided Tour',
   'golf-cart-guided-tour',
   'Two-hour guided golf cart tour through North Bimini with certified guide.',
   120, 6, 'fixed', '#3A9B9F', true,
   '{"seed_source": "2026-05-30 migration from email_templates + tourbimini.com", "pricing_shape": "starting_at_flat"}'::jsonb)
ON CONFLICT (user_id, slug) WHERE slug IS NOT NULL DO NOTHING;
