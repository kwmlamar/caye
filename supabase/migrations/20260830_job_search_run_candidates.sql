-- Preserve exact sourcing-run membership and scoring snapshots so founder observability
-- can distinguish a specific run from the cumulative candidate pool.
create table if not exists public.job_search_run_candidates (
  run_id uuid not null references public.job_search_runs(id) on delete cascade,
  candidate_id uuid not null references public.job_search_candidates(id) on delete cascade,
  canonical_key text not null,
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
  'Immutable-ish per-run snapshots of candidates observed/scored by a job-search source run. Service-role runtime only; founder access is mediated through Caye tools.';
