-- 2026-07-28 — expose the applied-migration ledger to the app, read-only.
--
-- Migrations are applied by hand here, and three separate ones sat written-
-- but-never-applied for weeks each before a user-visible failure exposed
-- them (caye_admin_pending_actions killed Admin Shell's high-risk gate for
-- 7 days; workspace_ai_config.ai_enabled was missing for 2 months, 400-ing
-- every query that selected it and taking system_prompt down with it). See
-- lib/db/migration-drift.ts for the checker this backs.
--
-- supabase_migrations is not in PostgREST's exposed schemas, so the app
-- can't read schema_migrations directly. SECURITY DEFINER + an explicit
-- grant to service_role only: this is deploy metadata, not something anon
-- or authenticated callers have any business reading.

create or replace function public.applied_migration_names()
  returns setof text
  language sql
  security definer
  set search_path = ''
  stable
as $$
  select name from supabase_migrations.schema_migrations;
$$;

revoke all on function public.applied_migration_names() from public;
revoke all on function public.applied_migration_names() from anon;
revoke all on function public.applied_migration_names() from authenticated;
grant execute on function public.applied_migration_names() to service_role;
