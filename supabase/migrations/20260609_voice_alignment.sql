-- Owner-confirmed voice alignment.
-- Set when the workspace owner reviews + confirms what Caye extracted
-- from their sent messages (signature, tagline, sign-off, opener).
-- The dashboard "Get aligned with Caye" card hides once this is non-null.
ALTER TABLE customers
  ADD COLUMN voice_alignment_confirmed_at timestamptz;
