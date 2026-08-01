-- business_facts.expires_at (2026-07-30)
--
-- Temporary owner-taught notes (a vacation closure, a one-off promo) need
-- a way to self-expire instead of lingering in Caye's prompt context
-- forever once stale. Nullable — most facts are evergreen and never set
-- this. fetchBusinessFacts (lib/business-facts.ts) filters out expired
-- rows; remove_business_fact still exists for manual early removal.
ALTER TABLE business_facts
  ADD COLUMN expires_at timestamptz;
