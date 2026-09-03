-- Extend the canonical Direction capability-evidence model (20260830b) beyond
-- perception (20260830j) to four more capabilities that already have a real
-- runtime OUTCOME signal in the schema. Follows 20260830j's structure and
-- restraint: each trigger publishes only demonstrated behavior/outcome into
-- Direction, and never touches maturity_status or progress_percent. Progress
-- still requires the existing trigger's verified-evidence pairing plus a
-- deliberate founder decision.
--
-- Candidates evaluated against the repo audit that motivated this migration
-- (research_intelligence, engineering_copilot, human_command_interface,
-- memory_context) all had a genuine completion signal already recorded by
-- existing runtime code, so all four are bridged here. No other capability
-- was touched: nothing in the schema records a completed reasoning/planning/
-- proactive-operator outcome today, so those remain unverified rather than
-- being given a fabricated bridge.
--
-- verifies_capability = true only when the source row records that the work
-- actually finished with a real result (a completed research brief backed by
-- cited evidence; a coding session whose tests and build actually passed and
-- was pushed; a Caye Direct run that ran to completion; an operator learning
-- decision that actually wrote to an authoritative memory store). A queued,
-- running, candidate, or merely-started row is implementation evidence, not
-- capability evidence, and is never published by these triggers.

-- ---------------------------------------------------------------------------
-- research_intelligence <- research_runs.status = 'completed'
--
-- research_runs.status only becomes 'completed' via persist_research_synthesis
-- (20260830b_research_runtime_integrity.sql), which requires at least one
-- claim whose cited evidence was actually observed by the run and commits a
-- brief revision atomically with it. A started/queued/running/partial/failed
-- run is never published.
create or replace function public.publish_research_direction_evidence()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_capability_id uuid;
begin
  if new.status <> 'completed' or new.completed_at is null then
    return new;
  end if;

  select id into v_capability_id
    from public.caye_operating_intelligence_capabilities
   where capability_key = 'research_intelligence';

  if v_capability_id is null then
    raise exception 'canonical Research & Intelligence capability is missing';
  end if;

  insert into public.caye_operating_intelligence_capability_evidence (
    capability_id, evidence_kind, source_ref, summary, verifies_capability,
    confidence, observed_at, verified_at
  ) values (
    v_capability_id,
    'outcome',
    'research_run:' || new.id::text,
    'Research run completed with a synthesized brief backed by cited, run-observed evidence.',
    true,
    1,
    new.completed_at,
    new.completed_at
  )
  on conflict (capability_id, evidence_kind, source_ref)
  do update set
    summary = excluded.summary,
    verifies_capability = true,
    confidence = excluded.confidence,
    observed_at = excluded.observed_at,
    verified_at = excluded.verified_at;

  return new;
end;
$$;

revoke execute on function public.publish_research_direction_evidence() from public, anon, authenticated;
grant execute on function public.publish_research_direction_evidence() to service_role;

drop trigger if exists trg_publish_research_direction_evidence on public.research_runs;
create trigger trg_publish_research_direction_evidence
after insert or update of status, completed_at, provider
on public.research_runs
for each row
execute function public.publish_research_direction_evidence();

comment on function public.publish_research_direction_evidence() is
  'Publishes only completed, evidence-backed research runs into canonical Direction evidence; never mutates maturity or numeric progress.';

-- ---------------------------------------------------------------------------
-- engineering_copilot <- caye_coding_sessions with passing gates that were pushed
--
-- caye_coding_sessions_branch_verdict_truth_check (20260830o) already
-- guarantees that engineering_verdict = 'branch_verified' implies
-- gate_test_passed, gate_build_passed, work_branch, and final_commit_sha are
-- all set and production_verified is false. This publishes exactly that
-- verified branch outcome (or the stronger production_verified case), never a
-- session that is merely running, failed, or timed out.
create or replace function public.publish_engineering_copilot_direction_evidence()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_capability_id uuid;
  v_observed_at timestamptz;
begin
  if new.status <> 'pushed'
     or coalesce(new.engineering_verdict, '') not in ('branch_verified', 'production_verified')
     or new.gate_test_passed is not true
     or new.gate_build_passed is not true
     or new.work_branch is null
     or new.final_commit_sha is null then
    return new;
  end if;

  select id into v_capability_id
    from public.caye_operating_intelligence_capabilities
   where capability_key = 'engineering_copilot';

  if v_capability_id is null then
    raise exception 'canonical Engineering Copilot capability is missing';
  end if;

  v_observed_at := coalesce(new.finished_at, now());

  insert into public.caye_operating_intelligence_capability_evidence (
    capability_id, evidence_kind, source_ref, summary, verifies_capability,
    confidence, observed_at, verified_at
  ) values (
    v_capability_id,
    'outcome',
    'coding_session:' || new.id::text,
    'Coding session passed automated tests and build on an isolated review branch and was pushed.',
    true,
    1,
    v_observed_at,
    v_observed_at
  )
  on conflict (capability_id, evidence_kind, source_ref)
  do update set
    summary = excluded.summary,
    verifies_capability = true,
    confidence = excluded.confidence,
    observed_at = excluded.observed_at,
    verified_at = excluded.verified_at;

  return new;
end;
$$;

revoke execute on function public.publish_engineering_copilot_direction_evidence() from public, anon, authenticated;
grant execute on function public.publish_engineering_copilot_direction_evidence() to service_role;

drop trigger if exists trg_publish_engineering_copilot_direction_evidence on public.caye_coding_sessions;
create trigger trg_publish_engineering_copilot_direction_evidence
after insert or update of status, gate_test_passed, gate_build_passed, engineering_verdict, work_branch, final_commit_sha, finished_at
on public.caye_coding_sessions
for each row
execute function public.publish_engineering_copilot_direction_evidence();

comment on function public.publish_engineering_copilot_direction_evidence() is
  'Publishes only coding sessions with actually-passing tests and build that were pushed into canonical Direction evidence; never mutates maturity or numeric progress.';

-- ---------------------------------------------------------------------------
-- human_command_interface <- caye_direct_runs.status = 'completed'
--
-- A Caye Direct run only reaches 'completed' via finishDirectRun once the
-- objective actually finished (lib/caye-direct-runs.ts); queued/planning/
-- running/waiting_user/paused/failed/cancelled runs are never published.
create or replace function public.publish_human_command_direction_evidence()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_capability_id uuid;
  v_observed_at timestamptz;
begin
  if new.status <> 'completed' or new.completed_at is null then
    return new;
  end if;

  select id into v_capability_id
    from public.caye_operating_intelligence_capabilities
   where capability_key = 'human_command_interface';

  if v_capability_id is null then
    raise exception 'canonical Human Command Interface capability is missing';
  end if;

  v_observed_at := new.completed_at;

  insert into public.caye_operating_intelligence_capability_evidence (
    capability_id, evidence_kind, source_ref, summary, verifies_capability,
    confidence, observed_at, verified_at
  ) values (
    v_capability_id,
    'outcome',
    'caye_direct_run:' || new.id::text,
    'Caye Direct run was directed by the founder through the command surface and ran to completion.',
    true,
    1,
    v_observed_at,
    v_observed_at
  )
  on conflict (capability_id, evidence_kind, source_ref)
  do update set
    summary = excluded.summary,
    verifies_capability = true,
    confidence = excluded.confidence,
    observed_at = excluded.observed_at,
    verified_at = excluded.verified_at;

  return new;
end;
$$;

revoke execute on function public.publish_human_command_direction_evidence() from public, anon, authenticated;
grant execute on function public.publish_human_command_direction_evidence() to service_role;

drop trigger if exists trg_publish_human_command_direction_evidence on public.caye_direct_runs;
create trigger trg_publish_human_command_direction_evidence
after insert or update of status, completed_at
on public.caye_direct_runs
for each row
execute function public.publish_human_command_direction_evidence();

comment on function public.publish_human_command_direction_evidence() is
  'Publishes only Caye Direct runs that actually completed into canonical Direction evidence; never mutates maturity or numeric progress.';

-- ---------------------------------------------------------------------------
-- memory_context <- operator_learning_audit decisions that actually wrote durable memory
--
-- lib/operator-learning-router.ts only records decision in
-- ('written','superseded_and_written') with target_table/target_record_id set
-- after dispatchWrite() has already written to the authoritative store
-- (business_facts, service_pricing_tiers, operator_allowlist,
-- service_availability_rules, service_date_overrides). 'candidate', 'no_op',
-- 'rejected', and 'error' rows record a decision but no durable write, and
-- are never published. Audit rows are insert-only (one row per decision), so
-- this only needs to fire on insert.
create or replace function public.publish_memory_context_direction_evidence()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_capability_id uuid;
begin
  if new.decision not in ('written', 'superseded_and_written')
     or new.target_table is null
     or new.target_record_id is null then
    return new;
  end if;

  select id into v_capability_id
    from public.caye_operating_intelligence_capabilities
   where capability_key = 'memory_context';

  if v_capability_id is null then
    raise exception 'canonical Memory & Context capability is missing';
  end if;

  insert into public.caye_operating_intelligence_capability_evidence (
    capability_id, evidence_kind, source_ref, summary, verifies_capability,
    confidence, observed_at, verified_at
  ) values (
    v_capability_id,
    'outcome',
    'operator_learning_audit:' || new.id::text,
    case
      when new.decision = 'superseded_and_written'
        then 'An authorized operator correction superseded prior memory and was durably written to authoritative business memory.'
      else 'An authorized operator statement was durably written to authoritative business memory.'
    end,
    true,
    1,
    new.created_at,
    new.created_at
  )
  on conflict (capability_id, evidence_kind, source_ref)
  do update set
    summary = excluded.summary,
    verifies_capability = true,
    confidence = excluded.confidence,
    observed_at = excluded.observed_at,
    verified_at = excluded.verified_at;

  return new;
end;
$$;

revoke execute on function public.publish_memory_context_direction_evidence() from public, anon, authenticated;
grant execute on function public.publish_memory_context_direction_evidence() to service_role;

drop trigger if exists trg_publish_memory_context_direction_evidence on public.operator_learning_audit;
create trigger trg_publish_memory_context_direction_evidence
after insert
on public.operator_learning_audit
for each row
execute function public.publish_memory_context_direction_evidence();

comment on function public.publish_memory_context_direction_evidence() is
  'Publishes only operator-learning decisions that actually wrote durable memory into canonical Direction evidence; never mutates maturity or numeric progress.';
