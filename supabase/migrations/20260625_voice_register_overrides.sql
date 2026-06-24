-- 2026-06-25 — voice register + manual samples (#54)
--
-- Two thin JSONB columns on `customers` so the conversational voice tools
-- have somewhere to write without inventing a new table for v1.
--
-- voice_register_overrides — { default?, b2b?, vip? } where each value is one
--   of: warm-local | friendly-professional | formal-professional | casual.
--   The front-desk reply path picks `b2b` when the inbound is classified as
--   b2b_partnership (and the override exists), else `default`, else the
--   existing ai_voice_profile.formality_level — backwards compatible.
--
-- manual_voice_samples — array of { text, label?, added_at } strings the
--   owner pasted via add_voice_sample. Merged with the inbox-derived
--   samples in the extractor input so the next re-train sees them.

alter table public.customers
  add column if not exists voice_register_overrides jsonb not null default '{}'::jsonb,
  add column if not exists manual_voice_samples jsonb not null default '[]'::jsonb;

comment on column public.customers.voice_register_overrides is
  'Per-scope voice register override. Shape: { default?, b2b?, vip? } with values warm-local | friendly-professional | formal-professional | casual. Set via update_voice_register tool.';
comment on column public.customers.manual_voice_samples is
  'Array of { text, label?, added_at } samples the owner pasted via add_voice_sample. Merged with inbox-derived samples on next voice profile re-train.';
