-- 2026-09-02 — expose the ledger's identity metadata, read-only.
--
-- 20260728b_applied_migration_names_rpc returns `setof text`: names, nothing
-- else. That is enough for the drift watchdog (lib/db/migration-drift.ts),
-- which only asks "is this migration recorded at all", but not for the
-- identity audit in scripts/check-migration-ledger.mjs, which needs to tell
-- apart:
--
--   * a row deliberately written by a reconciliation
--     (created_by like 'migration-drift-reconciliation-%', e.g. the fifteen
--     inserted on 2026-09-02 for migrations whose schema was already live)
--   * genuinely pre-convention history, which is old and should not be
--     re-litigated on every run (needs `version` to bound by date)
--   * a duplicate apply (needs `version` to say WHICH rows collided)
--
-- Without these columns the audit can still find aliases and unrecorded
-- migrations, but it cannot honour the documented exception for
-- reconciliation rows, and its noise floor is every pre-convention name ever
-- recorded. `applied_migration_names` is left exactly as it is: the watchdog
-- depends on it and has no use for the extra columns.
--
-- Same security posture as its predecessor. supabase_migrations is outside
-- PostgREST's exposed schemas, so this is SECURITY DEFINER with an empty
-- search_path and a fully-qualified read. Deploy metadata is service-role
-- business only; anon and authenticated get nothing.
--
-- Read-only by construction: a `select` in a `stable` sql function cannot
-- write, and the ledger is never modified here.

create or replace function public.applied_migration_ledger()
  returns table (version text, name text, created_by text)
  language sql
  security definer
  set search_path = ''
  stable
as $$
  select m.version, m.name, m.created_by
  from supabase_migrations.schema_migrations m;
$$;

revoke all on function public.applied_migration_ledger() from public;
revoke all on function public.applied_migration_ledger() from anon;
revoke all on function public.applied_migration_ledger() from authenticated;
grant execute on function public.applied_migration_ledger() to service_role;

comment on function public.applied_migration_ledger() is
  'Service-role-only read of the migration ledger''s identity columns. Backs the repo-vs-ledger identity audit in scripts/check-migration-ledger.mjs; the drift watchdog continues to use applied_migration_names().';
