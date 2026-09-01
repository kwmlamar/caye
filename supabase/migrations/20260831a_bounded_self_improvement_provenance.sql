-- Bounded self-improvement: every autonomous engineering session is rooted in
-- one canonical recommendation. The database owns dedupe and immutable origin.

alter table public.caye_coding_sessions
  add column if not exists recommendation_id uuid references public.caye_recommendations(id) on delete restrict,
  add column if not exists recommendation_fingerprint text,
  add column if not exists recommendation_provenance jsonb not null default '{}'::jsonb,
  add column if not exists self_improvement_session boolean not null default false;

create unique index if not exists caye_coding_sessions_one_per_recommendation_idx
  on public.caye_coding_sessions(recommendation_id)
  where recommendation_id is not null;

create index if not exists caye_coding_sessions_recommendation_lookup_idx
  on public.caye_coding_sessions(workspace_id, recommendation_id, created_at desc)
  where recommendation_id is not null;

do $$ begin
  alter table public.caye_coding_sessions add constraint caye_coding_sessions_recommendation_origin_check
    check (
      (not self_improvement_session and recommendation_id is null)
      or (
        self_improvement_session
        and recommendation_id is not null
        and recommendation_fingerprint is not null
        and btrim(recommendation_fingerprint) <> ''
        and recommendation_provenance <> '{}'::jsonb
      )
    );
exception when duplicate_object then null; end $$;

create or replace function public.caye_guard_coding_session_recommendation_provenance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r_scope text;
  r_workspace uuid;
  r_fingerprint text;
begin
  if new.recommendation_id is null then
    if new.self_improvement_session then
      raise exception 'self-improvement coding session requires canonical recommendation';
    end if;
    return new;
  end if;

  select scope, workspace_id, fingerprint
    into r_scope, r_workspace, r_fingerprint
  from public.caye_recommendations
  where id = new.recommendation_id;

  if r_scope is null then raise exception 'canonical recommendation does not exist'; end if;
  if r_fingerprint is distinct from new.recommendation_fingerprint then
    raise exception 'coding-session recommendation fingerprint mismatch';
  end if;
  if r_scope = 'workspace' and (new.workspace_id is null or new.workspace_id is distinct from r_workspace) then
    raise exception 'coding-session recommendation is outside workspace scope';
  end if;
  if r_scope = 'operator' and new.workspace_id is not null then
    raise exception 'operator recommendation cannot be relabeled as workspace engineering';
  end if;

  if tg_op = 'UPDATE' and (
    new.recommendation_id is distinct from old.recommendation_id
    or new.recommendation_fingerprint is distinct from old.recommendation_fingerprint
    or new.recommendation_provenance is distinct from old.recommendation_provenance
    or new.self_improvement_session is distinct from old.self_improvement_session
  ) then
    raise exception 'coding-session recommendation provenance is immutable';
  end if;
  return new;
end;
$$;

revoke all on function public.caye_guard_coding_session_recommendation_provenance() from public, anon, authenticated;
grant execute on function public.caye_guard_coding_session_recommendation_provenance() to service_role;

drop trigger if exists caye_coding_session_recommendation_provenance_guard on public.caye_coding_sessions;
create trigger caye_coding_session_recommendation_provenance_guard
before insert or update of recommendation_id, recommendation_fingerprint, recommendation_provenance, self_improvement_session, workspace_id
on public.caye_coding_sessions
for each row execute function public.caye_guard_coding_session_recommendation_provenance();
