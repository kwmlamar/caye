alter table public.job_search_resume_variants
  drop constraint if exists job_search_resume_variants_variant_key_check;

alter table public.job_search_resume_variants
  add constraint job_search_resume_variants_variant_key_check
  check (variant_key = any (array['it_support'::text, 'full_stack'::text, 'backend_platform'::text, 'ai_llm'::text]));
