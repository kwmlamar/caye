-- 2026-08-26 — Operator Learning Router, contradiction-handling hardening
-- pass: scope canonical-key chaining by service.
--
-- WHY
-- write_business_fact_atomic's canonical-key row-lock chain (20260826) was
-- scoped only by (workspace_id, canonical_key) — NOT by service_id. Real
-- risk this creates, confirmed against production shape: if a classifier
-- ever assigns the SAME canonical_key to both a workspace-wide fact and a
-- service-specific one about a related topic (a realistic mistake — e.g.
-- "pickup-location" used for both "the pickup for all tours is X" and "the
-- Heritage Tour pickup is Y"), the chain-lock would silently supersede
-- ACROSS scope boundaries: a service-specific exception could be wiped out
-- by a later workspace-wide correction that was never actually meant to
-- override it, or vice versa. Confirmed real production evidence this class
-- of ambiguity is not hypothetical: business_facts currently holds BOTH
-- "the meeting point for the Heritage Tour is the pink building by the
-- dock" (service-scoped, 2026-06-25) and "the pickup location for all tours
-- is the Casino Tram Stop" (workspace-wide, 2026-08-26) simultaneously
-- active, un-reconciled — exactly the shape of statement pair a
-- same-canonical-key collision could have silently resolved the wrong way.
--
-- WHAT THIS CHANGES
--   - The active-canonical-key uniqueness constraint now also includes
--     service_id (via a NULL-safe coalesce to a sentinel "no service" UUID,
--     since Postgres unique indexes treat NULL <> NULL by default and would
--     otherwise silently stop enforcing uniqueness among workspace-wide
--     facts). A workspace-wide fact and a service-scoped fact can now share
--     the same canonical_key without colliding.
--   - write_business_fact_atomic's canonical-key chain lookup is scoped the
--     same way: it only finds/locks/supersedes a PRIOR fact with the SAME
--     canonical_key AND the SAME scope (same service_id, or both
--     workspace-wide). A workspace-wide correction never automatically
--     chains onto — and therefore never automatically retires — a
--     service-specific fact just because a classifier reused its key, and
--     the reverse is also true.
--   - The explicit p_supersede_id path (an LLM-judged, cross-scope-aware
--     contradiction — see business-fact-conflict.ts's scope-label
--     enrichment, added the same day) is UNCHANGED and deliberately still
--     scope-agnostic: a genuine, judged cross-scope contradiction (the
--     conflict judge explicitly decided a general claim really does
--     override a specific one) can still supersede across the boundary.
--     Only the coincidental, un-judged canonical-key MATCH is now
--     scope-aware — the judged case always was, and still is, allowed to
--     cross it.
--
-- Reversible: drop the new index, recreate the prior one, restore the RPC
-- to the 20260826 version.

drop index if exists public.business_facts_active_canonical_key_idx;

create unique index if not exists business_facts_active_canonical_key_scope_idx
  on public.business_facts (
    workspace_id,
    canonical_key,
    coalesce(service_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where superseded_at is null and canonical_key is not null;

create or replace function public.write_business_fact_atomic(
  p_workspace_id uuid,
  p_category text,
  p_fact text,
  p_source text,
  p_created_by text,
  p_service_id uuid default null,
  p_canonical_key text default null,
  p_expires_at timestamptz default null,
  p_supersede_id uuid default null
) returns table (id uuid, created_at timestamptz, superseded_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chain_target_id uuid;
  v_explicit_target_workspace uuid;
  v_explicit_target_superseded_at timestamptz;
  v_effective_supersede_id uuid;
  v_new_id uuid;
  v_new_created_at timestamptz;
begin
  if p_canonical_key is not null then
    select business_facts.id into v_chain_target_id
      from public.business_facts
      where business_facts.workspace_id = p_workspace_id
        and business_facts.canonical_key = p_canonical_key
        -- Scope-matched chaining only (this migration's fix): a
        -- workspace-wide write (p_service_id null) only ever chains onto
        -- another workspace-wide fact; a service-scoped write only chains
        -- onto a fact scoped to that SAME service. Never across the
        -- boundary via coincidental key reuse alone.
        and coalesce(business_facts.service_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce(p_service_id, '00000000-0000-0000-0000-000000000000'::uuid)
        and business_facts.superseded_at is null
      for update;
  end if;

  if p_supersede_id is not null then
    select business_facts.workspace_id, business_facts.superseded_at
      into v_explicit_target_workspace, v_explicit_target_superseded_at
      from public.business_facts
      where business_facts.id = p_supersede_id
      for update;

    if v_explicit_target_workspace is null then
      raise exception 'business fact % not found', p_supersede_id
        using errcode = 'P0002';
    end if;
    if v_explicit_target_workspace <> p_workspace_id then
      raise exception 'business fact % does not belong to workspace %', p_supersede_id, p_workspace_id
        using errcode = '42501';
    end if;
    if v_explicit_target_superseded_at is not null then
      raise exception 'business fact % is already superseded', p_supersede_id
        using errcode = '22023';
    end if;
  end if;

  -- Prefer an explicit LLM-identified conflict target (may legitimately
  -- cross a scope boundary — the judge reasoned about it explicitly); fall
  -- back to the scope-matched canonical-key chain target when there is no
  -- explicit one (they will often be the same row).
  v_effective_supersede_id := coalesce(p_supersede_id, v_chain_target_id);

  -- ORDER MATTERS: the active-canonical-key unique index is checked
  -- immediately (non-deferrable), not at end of transaction. The old row is
  -- freed from the index FIRST (superseded_at set, superseded_by filled in
  -- after), THEN the new row is inserted, THEN the old row's superseded_by
  -- is backfilled with the now-known new id. All three statements are still
  -- one transaction — a failure anywhere rolls back all of them.
  if v_effective_supersede_id is not null then
    update public.business_facts
      set superseded_at = now()
      where business_facts.id = v_effective_supersede_id
        and business_facts.superseded_at is null;
  end if;

  insert into public.business_facts
    (workspace_id, category, fact, source, created_by, service_id, canonical_key, expires_at)
    values (p_workspace_id, p_category, p_fact, p_source, p_created_by, p_service_id, p_canonical_key, p_expires_at)
    returning business_facts.id, business_facts.created_at
    into v_new_id, v_new_created_at;

  if v_effective_supersede_id is not null then
    update public.business_facts
      set superseded_by = v_new_id
      where business_facts.id = v_effective_supersede_id;
  end if;

  return query select v_new_id, v_new_created_at, v_effective_supersede_id;
end;
$$;

revoke all on function public.write_business_fact_atomic(uuid, text, text, text, text, uuid, text, timestamptz, uuid) from public;
revoke all on function public.write_business_fact_atomic(uuid, text, text, text, text, uuid, text, timestamptz, uuid) from anon;
revoke all on function public.write_business_fact_atomic(uuid, text, text, text, text, uuid, text, timestamptz, uuid) from authenticated;
grant execute on function public.write_business_fact_atomic(uuid, text, text, text, text, uuid, text, timestamptz, uuid) to service_role;
