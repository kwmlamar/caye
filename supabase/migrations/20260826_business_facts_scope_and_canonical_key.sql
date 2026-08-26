-- 2026-08-26 — Operator Learning Router, part 1: business_facts scope +
-- canonical-key-locked writes.
--
-- WHY
-- business_facts had no structural service scope (a fact is either
-- workspace-wide by convention or service-specific purely by how the
-- sentence happens to be worded — nothing in the schema or retrieval path
-- enforces or even records which). It also had no stable identity for "this
-- is the same underlying fact restated" independent of the free-text
-- contradiction judge (findConflictingFact) — which is an LLM call and
-- therefore cannot itself be the thing two concurrent writers serialize on.
--
-- WHAT THIS ADDS
--   business_facts.service_id     — nullable FK. NULL = workspace-wide
--                                    (matches every existing row's actual
--                                    behavior — no backfill needed). Set only
--                                    by callers that resolved a specific
--                                    service deterministically.
--   business_facts.canonical_key  — nullable. A stable identifier for "this
--                                    topic" independent of exact wording,
--                                    assigned by the operator-learning
--                                    classifier. NULL for facts saved through
--                                    the existing add_business_fact /
--                                    confirm_fact_candidate tools, which have
--                                    no such concept and are unaffected by
--                                    this migration.
--
--   write_business_fact_atomic()  — new RPC, additive alongside the existing
--                                    add_business_fact_with_supersession
--                                    (20260819). The existing RPC and its
--                                    callers (add-business-fact.ts,
--                                    confirm-fact-candidate.ts) are untouched.
--                                    This new one is for the operator-learning
--                                    router only.
--
-- CONCURRENCY
-- Two operators independently correcting the same fact at nearly the same
-- moment (or one WhatsApp webhook delivering the same message twice) must
-- never leave two rows simultaneously active for the same canonical_key.
-- Advisory locks held across an LLM round-trip are not safe here — Supabase's
-- pooled connections mean a session-level lock can silently apply to a
-- different physical connection on the next call. So the lock this function
-- takes is an ordinary Postgres row lock (`for update`), acquired and
-- released entirely inside ONE function invocation (one transaction, one
-- connection, always safe): it locks whichever row is CURRENTLY active for
-- (workspace_id, canonical_key), supersedes it, and inserts the new row with
-- the same canonical_key. A second concurrent call for the same key blocks on
-- that row lock until the first commits, then finds the FIRST call's new row
-- as the now-active one and supersedes THAT instead — serializing into a
-- clean chain (fact1 -> superseded by fact2 -> superseded by fact3) rather
-- than ever producing two active rows for the same key.
--
-- p_supersede_id (optional, separate from canonical-key chaining) lets the
-- caller also pass an LLM-identified conflicting row from a DIFFERENT
-- canonical_key (or one with no canonical_key at all, e.g. an older fact
-- saved through add_business_fact) — same workspace/not-already-superseded
-- validation as the existing RPC.
--
-- Reversible: drop the function and the two columns.

alter table public.business_facts
  add column if not exists service_id uuid references public.booking_services (id) on delete set null;

alter table public.business_facts
  add column if not exists canonical_key text;

comment on column public.business_facts.service_id is
  'NULL = workspace-wide (default/legacy behavior). Set when a fact was resolved to a specific service — currently only by the operator-learning router.';
comment on column public.business_facts.canonical_key is
  'Stable topic identity assigned by the operator-learning classifier, used by write_business_fact_atomic to chain supersessions safely under concurrency. NULL for facts saved through add_business_fact / confirm_fact_candidate.';

create index if not exists business_facts_service_idx
  on public.business_facts (workspace_id, service_id)
  where service_id is not null;

-- One active row per (workspace, canonical_key). Enforced structurally so
-- write_business_fact_atomic's row-lock chaining is backed by a real
-- constraint, not just application discipline.
create unique index if not exists business_facts_active_canonical_key_idx
  on public.business_facts (workspace_id, canonical_key)
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

  -- Prefer an explicit LLM-identified conflict target; fall back to the
  -- canonical-key chain target when there is no explicit one (they will
  -- often be the same row).
  v_effective_supersede_id := coalesce(p_supersede_id, v_chain_target_id);

  -- ORDER MATTERS: business_facts_active_canonical_key_idx is a partial
  -- unique index on (workspace_id, canonical_key) WHERE superseded_at IS
  -- NULL. If the new row were inserted before the old one is marked
  -- superseded, both rows would momentarily satisfy the index's WHERE
  -- clause with the same canonical_key and the insert would fail on a
  -- unique-violation — Postgres checks a non-deferrable unique index
  -- immediately, not at end of transaction. So the old row is freed from
  -- the index FIRST (superseded_at set, superseded_by filled in after),
  -- THEN the new row is inserted, THEN the old row's superseded_by is
  -- backfilled with the now-known new id. All three statements are still
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
