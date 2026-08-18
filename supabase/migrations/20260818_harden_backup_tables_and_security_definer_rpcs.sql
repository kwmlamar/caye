-- 2026-08-18 — CAY-15: close the Supabase security advisor findings that are
-- safe to close without a live-schema source read, and pin search_path on
-- every flagged SECURITY DEFINER function regardless.
--
-- ERROR: RLS disabled on two backup tables in the exposed public schema
-- ------------------------------------------------------------------------
-- bookings_dedupe_backup_20260811 and bookings_karin_dedupe_backup_20260811
-- are not created by any tracked migration and have zero references
-- anywhere in this repo (grepped app/**, lib/**, supabase/migrations/**).
-- They are one-off snapshots taken before a manual dedupe operation on
-- 2026-08-11, left behind with RLS disabled — i.e. world-readable to
-- anyone holding the publishable anon key, via PostgREST's default exposure
-- of every public-schema table. No code path needs anon/authenticated
-- access to a backup table, so this is a straight fail-closed fix: enable
-- RLS with zero policies, same deny-by-default posture as
-- 20260807b_enable_rls_service_role_only_tables.sql. Service-role access
-- (the only access these should ever need, if restored from) keeps working
-- because service_role bypasses RLS by design.
--
-- Reversible: alter table ... disable row level security.

alter table public.bookings_dedupe_backup_20260811       enable row level security;
alter table public.bookings_karin_dedupe_backup_20260811 enable row level security;

-- WARN: SECURITY DEFINER functions executable by anon/authenticated
-- ------------------------------------------------------------------------
-- Six functions flagged. Two are fixed here; four are intentionally
-- retained. See the PR description for the full caller audit.
--
-- FIXED — ensure_founder_in_workspace_members() and handle_new_auth_user():
-- both are `returns trigger` functions (confirmed for the former by its
-- source in 20260728_ensure_founder_in_workspace_members.sql; confirmed for
-- the latter by app/auth/callback/page.tsx, which documents it as the DB
-- trigger that seeds workspace_members for a new auth user). Postgres fires
-- triggers under the authority of the statement that fired them, not via an
-- EXECUTE grant to the invoking role — same reasoning already established
-- in 20260807f_workspace_events_revoke_rpc.sql — so revoking EXECUTE here
-- does not touch the trigger behavior at all, only closes the direct
-- /rest/v1/rpc/<name> RPC surface PostgREST otherwise exposes for every
-- public-schema function.
--
-- RETAINED — is_member_of(uuid) and check_message_access(uuid): these take
-- an explicit uuid argument, which a trigger function structurally cannot
-- (trigger functions declare zero parameters). There are no .rpc() call
-- sites for either in this repo. Names match the idiomatic Supabase
-- RLS-policy-predicate pattern (a policy's USING clause calling
-- is_member_of(workspace_id)), in which case Postgres evaluates the policy
-- as the *querying* role and needs that role to hold EXECUTE on the
-- function even though the function body runs with definer rights.
-- Revoking EXECUTE without confirming this against the live schema risks
-- silently breaking every RLS-gated query that depends on them — which
-- this runner has no authorized live-DB access to verify. Left untouched
-- pending a source/policy read against the actual database.
--
-- RETAINED — create_assignment_notification() and
-- create_message_notification(): no in-repo source (both predate migration
-- tracking). Zero-arg signature is consistent with a trigger (notifications
-- is only ever read/updated by app code in lib/supabase.ts, never inserted,
-- and NotificationType includes 'assignment' and 'new_message' — matching
-- these names), but that is circumstantial, not a confirmed `returns
-- trigger`. Left untouched rather than guessing at a production RPC's
-- return type; flagged for a live-schema follow-up alongside the two above.
--
-- Reversible: grant execute on ... to anon, authenticated.

revoke execute on function public.ensure_founder_in_workspace_members() from public, anon, authenticated;
revoke execute on function public.handle_new_auth_user()                from public, anon, authenticated;

-- WARN: mutable search_path on SECURITY DEFINER functions
-- ------------------------------------------------------------------------
-- Applies to all six flagged functions, including the four left untouched
-- above. Pinning search_path is orthogonal to the EXECUTE-grant question
-- above and carries none of that risk: it does not remove any capability
-- from any role, it only stops a caller from manipulating the session's
-- search_path to shadow an unqualified table/type reference with an
-- attacker-controlled object in another schema before invoking a definer
-- function (the classic SECURITY DEFINER search_path hijack). Pinning to
-- 'public' reproduces today's effective resolution for public-schema
-- objects — it does not change behavior for any legitimate caller, only
-- closes the hijack path. Applied via ALTER FUNCTION so no function body
-- needs to be known or rewritten.
--
-- Reversible: alter function ... reset search_path.

alter function public.check_message_access(uuid)             set search_path = public;
alter function public.create_assignment_notification()        set search_path = public;
alter function public.create_message_notification()           set search_path = public;
alter function public.ensure_founder_in_workspace_members()    set search_path = public;
alter function public.handle_new_auth_user()                   set search_path = public;
alter function public.is_member_of(uuid)                       set search_path = public;
