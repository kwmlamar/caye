-- Lock internal SECURITY DEFINER functions behind the roles that actually need them.
-- These functions bypass caller table privileges by design, so direct EXECUTE
-- grants are part of the authorization boundary and must be explicit.

-- Conversation execution lifecycle is internal server orchestration only.
revoke all on function public.claim_conversation_execution(uuid,uuid,text,text,uuid,text,integer) from public, anon, authenticated;
revoke all on function public.validate_conversation_execution(uuid,uuid) from public, anon, authenticated;
revoke all on function public.complete_conversation_execution(uuid,uuid) from public, anon, authenticated;
revoke all on function public.release_conversation_execution(uuid) from public, anon, authenticated;
revoke all on function public.mark_conversation_execution_ambiguous(uuid) from public, anon, authenticated;
revoke all on function public.abandon_conversation_execution_response(uuid) from public, anon, authenticated;

grant execute on function public.claim_conversation_execution(uuid,uuid,text,text,uuid,text,integer) to service_role;
grant execute on function public.validate_conversation_execution(uuid,uuid) to service_role;
grant execute on function public.complete_conversation_execution(uuid,uuid) to service_role;
grant execute on function public.release_conversation_execution(uuid) to service_role;
grant execute on function public.mark_conversation_execution_ambiguous(uuid) to service_role;
grant execute on function public.abandon_conversation_execution_response(uuid) to service_role;

-- Trigger-only functions must never be exposed as callable REST RPCs.
revoke all on function public.capture_job_search_run_candidate() from public, anon, authenticated;
revoke all on function public.create_assignment_notification() from public, anon, authenticated;
revoke all on function public.create_message_notification() from public, anon, authenticated;
revoke all on function public.ensure_founder_in_workspace_members() from public, anon, authenticated;
revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

grant execute on function public.capture_job_search_run_candidate() to service_role;
grant execute on function public.create_assignment_notification() to service_role;
grant execute on function public.create_message_notification() to service_role;
grant execute on function public.ensure_founder_in_workspace_members() to service_role;
grant execute on function public.handle_new_auth_user() to service_role;

-- Membership helpers intentionally serve signed-in RLS/access checks. Anonymous
-- callers have no authenticated identity and should not reach these DEFINER funcs.
revoke all on function public.check_message_access(uuid) from public, anon;
revoke all on function public.is_member_of(uuid) from public, anon;
grant execute on function public.check_message_access(uuid) to authenticated, service_role;
grant execute on function public.is_member_of(uuid) to authenticated, service_role;

-- Pin search_path on legacy DEFINER functions that previously inherited the
-- caller's role-mutable path.
alter function public.create_assignment_notification() set search_path = public, pg_temp;
alter function public.create_message_notification() set search_path = public, pg_temp;
alter function public.ensure_founder_in_workspace_members() set search_path = public, pg_temp;
alter function public.is_member_of(uuid) set search_path = public, pg_temp;
