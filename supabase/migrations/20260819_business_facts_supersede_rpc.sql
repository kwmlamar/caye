-- CAY-14 follow-up (2026-08-19) — atomic supersession.
--
-- WHY
-- 20260818_business_facts_supersession.sql added the superseded_by /
-- superseded_at columns, but add_business_fact and confirm_fact_candidate
-- wrote a replacement as two independent Supabase calls: insert the new
-- fact, then update the old one. Product/safety review on PR #83 flagged
-- that a failure on the second write leaves both facts "equally active" —
-- exactly the CAY-14 incident this feature exists to prevent, just moved
-- from "we never tried to supersede" to "we tried and half-failed".
--
-- WHAT THIS ADDS
-- One transactional RPC that performs the insert + supersede-update inside
-- a single Postgres function body. A function invoked as one statement is
-- atomic — if any statement inside it raises, Postgres rolls back every
-- effect of the call, so there is no path where the new fact exists but
-- the old one wasn't marked superseded, or vice versa. Modeled on
-- sales_apply_lifecycle_event (20260814b_sales_lifecycle_state.sql):
-- security definer, explicit search_path, service-role-only execute
-- grant, row-locked target lookup before mutating anything.
--
-- Strict validation runs before any row is touched: a non-null
-- p_supersede_id must reference a fact that exists, belongs to the SAME
-- workspace as the new fact (a cross-workspace id can never be used to
-- supersede — id confusion or a compromised caller must not let one
-- workspace's correction silently retire another workspace's fact), and
-- is not already superseded. Any violation raises and the function does
-- nothing at all — no partial insert, no orphaned new row.
--
-- Purely additive: creates one new function, touches no existing table or
-- row. Reversible: drop the function.

create or replace function public.add_business_fact_with_supersession(
  p_workspace_id uuid,
  p_category text,
  p_fact text,
  p_source text,
  p_created_by text,
  p_expires_at timestamptz default null,
  p_supersede_id uuid default null
) returns table (id uuid, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_workspace uuid;
  v_target_superseded_at timestamptz;
  v_new_id uuid;
  v_new_created_at timestamptz;
begin
  if p_supersede_id is not null then
    select business_facts.workspace_id, business_facts.superseded_at
      into v_target_workspace, v_target_superseded_at
      from public.business_facts
      where business_facts.id = p_supersede_id
      for update;

    if v_target_workspace is null then
      raise exception 'business fact % not found', p_supersede_id
        using errcode = 'P0002';
    end if;

    if v_target_workspace <> p_workspace_id then
      raise exception 'business fact % does not belong to workspace %', p_supersede_id, p_workspace_id
        using errcode = '42501';
    end if;

    if v_target_superseded_at is not null then
      raise exception 'business fact % is already superseded', p_supersede_id
        using errcode = '22023';
    end if;
  end if;

  insert into public.business_facts (workspace_id, category, fact, source, created_by, expires_at)
    values (p_workspace_id, p_category, p_fact, p_source, p_created_by, p_expires_at)
    returning business_facts.id, business_facts.created_at
    into v_new_id, v_new_created_at;

  if p_supersede_id is not null then
    update public.business_facts
      set superseded_by = v_new_id, superseded_at = now()
      where business_facts.id = p_supersede_id;
  end if;

  return query select v_new_id, v_new_created_at;
end;
$$;

revoke all on function public.add_business_fact_with_supersession(uuid, text, text, text, text, timestamptz, uuid) from public;
revoke all on function public.add_business_fact_with_supersession(uuid, text, text, text, text, timestamptz, uuid) from anon;
revoke all on function public.add_business_fact_with_supersession(uuid, text, text, text, text, timestamptz, uuid) from authenticated;
grant execute on function public.add_business_fact_with_supersession(uuid, text, text, text, text, timestamptz, uuid) to service_role;
