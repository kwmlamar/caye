-- Research Runtime V1 scope hardening.
-- The V1 worker is founder/operator scoped. Enforce that invariant in the
-- database claim boundary so a future workspace research run cannot be consumed
-- accidentally by the founder worker even if another service inserts it.

create or replace function public.claim_research_run(p_worker text)
returns setof public.research_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_worker is null or btrim(p_worker) = '' then
    raise exception 'research worker id is required';
  end if;

  select r.id into v_id
  from public.research_runs r
  join public.research_questions q on q.id = r.question_id
  join public.research_programs p on p.id = q.program_id
  where r.status = 'queued'
    and p.scope = 'operator'
    and p.status <> 'archived'
    and q.status <> 'archived'
  order by r.created_at
  for update of r skip locked
  limit 1;

  if v_id is null then
    return;
  end if;

  return query
  update public.research_runs
  set status = 'running',
      claimed_at = now(),
      claimed_by = btrim(p_worker),
      started_at = coalesce(started_at, now())
  where id = v_id and status = 'queued'
  returning *;
end
$$;

revoke all on function public.claim_research_run(text) from public, anon, authenticated;
grant execute on function public.claim_research_run(text) to service_role;
