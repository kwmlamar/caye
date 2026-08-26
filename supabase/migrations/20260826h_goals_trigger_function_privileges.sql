-- 2026-08-26 — Goal substrate trigger-function privilege hardening.
--
-- The scope guard functions are internal trigger helpers, not public RPCs.
-- Supabase grants EXECUTE to anon/authenticated by default for new functions,
-- so revoke those roles explicitly. The triggers themselves continue to run.

revoke execute on function public.enforce_caye_goal_parent_scope() from anon, authenticated;
revoke execute on function public.enforce_caye_goal_dependency_scope() from anon, authenticated;
