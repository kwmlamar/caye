-- Preserve exact sourcing-run membership and scoring snapshots so founder observability
-- can distinguish a specific run from the cumulative candidate pool.
create table if not exists public.job_search_run_candidates (
  run_id uuid not null references public.job_search_runs(id) on delete cascade,
  candidate_id uuid not null references public.job_search_candidates(id) on delete cascade,
  canonical_key text not null,
  company text not null,
  title text not null,
  location text,
  remote_type text,
  posted_at timestamptz,
  apply_url text,
  source_keys jsonb not null default '[]'::jsonb,
  discovered_via jsonb not null default '[]'::jsonb,
  fit_score integer,
  status text not null,
  bucket text not null,
  score_explanation jsonb,
  rejection_reasons jsonb,
  hard_block_reason text,
  recorded_at timestamptz not null default now(),
  primary key (run_id, candidate_id)
);

create index if not exists job_search_run_candidates_run_score_idx
  on public.job_search_run_candidates (run_id, fit_score desc nulls last, recorded_at desc);

create index if not exists job_search_run_candidates_candidate_idx
  on public.job_search_run_candidates (candidate_id, recorded_at desc);

alter table public.job_search_run_candidates enable row level security;

comment on table public.job_search_run_candidates is
  'Per-run candidate snapshots captured while a source run is active. Service-role runtime only; founder access is mediated through Caye tools.';

create or replace function public.capture_job_search_run_candidate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  active_run_id uuid;
  inferred_bucket text;
begin
  select id into active_run_id
  from public.job_search_runs
  where run_type = 'source' and status = 'running'
  order by started_at desc
  limit 1;

  if active_run_id is null then
    return new;
  end if;

  inferred_bucket := case
    when new.status = 'QUEUED' and coalesce(new.fit_score, 0) >= 85 then 'auto_queue'
    when new.status = 'QUEUED' then 'queue_if_capacity'
    when new.status = 'HUMAN_REVIEW' then 'review_low_priority'
    else 'reject'
  end;

  insert into public.job_search_run_candidates (
    run_id, candidate_id, canonical_key, company, title, location, remote_type,
    posted_at, apply_url, source_keys, discovered_via, fit_score, status, bucket,
    score_explanation, rejection_reasons, hard_block_reason, recorded_at
  ) values (
    active_run_id,
    new.id,
    new.canonical_key,
    new.company,
    new.title,
    new.location,
    new.remote_type,
    new.posted_at,
    new.apply_url,
    coalesce((select jsonb_agg(distinct item->>'sourceKey') from jsonb_array_elements(coalesce(new.discovered_via, '[]'::jsonb)) item where item ? 'sourceKey'), '[]'::jsonb),
    coalesce(new.discovered_via, '[]'::jsonb),
    new.fit_score,
    new.status,
    inferred_bucket,
    new.score_explanation,
    new.rejection_reasons,
    new.hard_block_reason,
    now()
  )
  on conflict (run_id, candidate_id) do update set
    canonical_key = excluded.canonical_key,
    company = excluded.company,
    title = excluded.title,
    location = excluded.location,
    remote_type = excluded.remote_type,
    posted_at = excluded.posted_at,
    apply_url = excluded.apply_url,
    source_keys = excluded.source_keys,
    discovered_via = excluded.discovered_via,
    fit_score = excluded.fit_score,
    status = excluded.status,
    bucket = excluded.bucket,
    score_explanation = excluded.score_explanation,
    rejection_reasons = excluded.rejection_reasons,
    hard_block_reason = excluded.hard_block_reason,
    recorded_at = excluded.recorded_at;

  return new;
end;
$$;

drop trigger if exists trg_capture_job_search_run_candidate on public.job_search_candidates;
create trigger trg_capture_job_search_run_candidate
after insert or update on public.job_search_candidates
for each row execute function public.capture_job_search_run_candidate();
