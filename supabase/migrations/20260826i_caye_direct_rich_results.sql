-- Canonical validated semantic result data for Caye Direct assistant turns.
alter table public.caye_operator_messages add column if not exists rich_result jsonb;
comment on column public.caye_operator_messages.rich_result is
  'Validated Caye Direct rich-result envelope. Semantic data only; never executable UI or rendered HTML.';
