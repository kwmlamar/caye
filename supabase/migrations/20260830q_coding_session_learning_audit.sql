-- Wave 2: feed qualifying software coding-session outcomes into the existing
-- operator_learning_audit without creating a parallel learning store.
--
-- This migration depends on 20260830o_engineering_copilot_closed_loop.sql.
-- It records candidate evidence only. Reusable software-engineering memory is
-- intentionally NOT written here: one outcome is insufficient, and the current
-- reusable engineering-memory writer is property-domain scoped.

alter table public.caye_coding_sessions
  add column if not exists learning_key text;

create index if not exists caye_coding_sessions_learning_evidence_idx
  on public.caye_coding_sessions(workspace_id, repository_full_name, learning_key, engineering_verdict, created_at desc)
  where learning_key is not null and outcome_environment = 'production';

create or replace function public.capture_coding_session_learning_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_matching_count integer := 0;
  v_has_production_source boolean := false;
begin
  -- operator_learning_audit is workspace-scoped. Founder/global sessions must
  -- not be relabeled as customer-workspace evidence merely to manufacture data.
  if new.workspace_id is null then
    return new;
  end if;

  v_key := nullif(btrim(new.learning_key), '');
  if v_key is null then
    return new;
  end if;

  -- Only conclusive, independently observed production outcomes qualify.
  -- Branch/test/simulated evidence stays execution evidence, never learning evidence.
  if new.outcome_environment is distinct from 'production'
     or new.engineering_verdict not in ('production_verified', 'failed')
     or new.observed_outcome is null
     or btrim(new.observed_outcome) = ''
     or new.prediction_comparison is null
     or new.execution_evidence = '{}'::jsonb then
    return new;
  end if;

  v_has_production_source :=
    coalesce(new.execution_evidence->>'productionEvidenceSource', '') = 'production'
    or coalesce(new.execution_evidence->'evidenceSources', '[]'::jsonb) ? 'production';

  if not v_has_production_source then
    return new;
  end if;

  -- One durable audit candidate per coding session.
  if exists (
    select 1
    from public.operator_learning_audit a
    where a.classifier_version = 'software_engineering_outcome_learning_v1'
      and a.target_table = 'caye_coding_sessions'
      and a.target_record_id = new.id::text
  ) then
    return new;
  end if;

  -- Repetition is counted only across independent sessions with the same
  -- workspace, repository, stable learning key, conclusive verdict, and an
  -- independently labelled production evidence source.
  select count(distinct s.id)::integer
    into v_matching_count
  from public.caye_coding_sessions s
  where s.workspace_id = new.workspace_id
    and s.repository_full_name = new.repository_full_name
    and s.learning_key = v_key
    and s.engineering_verdict = new.engineering_verdict
    and s.outcome_environment = 'production'
    and s.observed_outcome is not null
    and btrim(s.observed_outcome) <> ''
    and s.prediction_comparison is not null
    and s.execution_evidence <> '{}'::jsonb
    and (
      coalesce(s.execution_evidence->>'productionEvidenceSource', '') = 'production'
      or coalesce(s.execution_evidence->'evidenceSources', '[]'::jsonb) ? 'production'
    );

  insert into public.operator_learning_audit (
    workspace_id,
    source_excerpt,
    classifier_version,
    explicitness,
    scope_kind,
    scope_target,
    risk_level,
    destination,
    canonical_key,
    decision,
    target_table,
    target_record_id,
    reason
  ) values (
    new.workspace_id,
    left(new.observed_outcome, 1000),
    'software_engineering_outcome_learning_v1',
    'inferred_from_action',
    'standing',
    'workspace',
    'consequential',
    'engineering_learning_candidate',
    'software_engineering_outcome:' || new.repository_full_name || ':' || v_key,
    'candidate',
    'caye_coding_sessions',
    new.id::text,
    case
      when v_matching_count < 2 then
        format(
          'Evidence-backed software engineering outcome is candidate only: %s independent matching production outcome(s); reusable learning requires at least 2.',
          v_matching_count
        )
      else
        format(
          'Repeated-evidence threshold is satisfied by %s independent matching production outcomes, but this audit bridge does not auto-promote software lessons into property/business memory.',
          v_matching_count
        )
    end
  );

  return new;
end;
$$;

revoke all on function public.capture_coding_session_learning_audit() from public, anon, authenticated;
grant execute on function public.capture_coding_session_learning_audit() to service_role;

drop trigger if exists coding_session_learning_audit_after_outcome on public.caye_coding_sessions;
create trigger coding_session_learning_audit_after_outcome
after insert or update of engineering_verdict, outcome_environment, observed_outcome, prediction_comparison, execution_evidence, learning_key
on public.caye_coding_sessions
for each row execute function public.capture_coding_session_learning_audit();
