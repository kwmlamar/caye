-- 2026-08-07 — revoke RPC access to the workspace_events functions
--
-- Follow-up to 20260807d, from the Supabase security advisor.
--
-- Every function that migration created is SECURITY DEFINER (they must be, to
-- read connected_accounts while resolving a workspace regardless of the
-- caller). PostgREST exposes any public-schema function as an RPC endpoint,
-- so all six landed at /rest/v1/rpc/<name> executable by `anon` and
-- `authenticated` — i.e. by anyone holding the publishable key from a browser
-- bundle.
--
-- The five trigger functions return `trigger` and Postgres refuses to call
-- those outside a trigger context, so they are noise. The real one is
-- caye_workspace_for_conversation(uuid): a callable scalar, running with
-- definer rights, that maps any conversation id to its workspace id while
-- bypassing RLS by design. That is an enumeration primitive and it should
-- never have been reachable from the internet.
--
-- Revoking EXECUTE does not affect the triggers. A trigger fires under the
-- authority of the statement that fired it, not via an EXECUTE grant to the
-- invoking role, so all five keep working with zero grants outstanding.
--
-- Same deny-by-default posture as 20260807b: service-role paths keep working
-- (service_role bypasses these grants), everything else drops to zero.
--
-- NOT FIXED HERE: seven pre-existing SECURITY DEFINER functions carry the
-- same exposure — check_message_access, create_assignment_notification,
-- create_message_notification, ensure_founder_in_workspace_members,
-- handle_new_auth_user, is_member_of, and update_* helpers. Those predate
-- this work and some are referenced by RLS policies, so revoking them needs
-- its own review rather than being smuggled into this migration.
--
-- Reversible: grant execute on ... to anon, authenticated.

revoke execute on function public.caye_workspace_for_conversation(uuid)  from public, anon, authenticated;
revoke execute on function public.caye_event_on_unified_message()        from public, anon, authenticated;
revoke execute on function public.caye_event_on_booking()                from public, anon, authenticated;
revoke execute on function public.caye_event_on_escalation()             from public, anon, authenticated;
revoke execute on function public.caye_event_on_hold_change()            from public, anon, authenticated;
revoke execute on function public.caye_event_on_connected_account()      from public, anon, authenticated;
revoke execute on function public.caye_seed_cursor_for_new_operator()    from public, anon, authenticated;
