-- Keep founder Direct work visibly active while a durable research run is queued/running.
-- The research runtime stays canonical; Direct only stores a typed linkage for UI lifecycle.

alter table public.caye_direct_runs
  add column if not exists linked_research_question_id uuid references public.research_questions(id) on delete set null,
  add column if not exists linked_research_run_id uuid references public.research_runs(id) on delete set null;

create index if not exists caye_direct_runs_linked_research_run_idx
  on public.caye_direct_runs (linked_research_run_id)
  where linked_research_run_id is not null;

comment on column public.caye_direct_runs.linked_research_question_id is
  'Canonical research question launched by this Direct run, when present.';
comment on column public.caye_direct_runs.linked_research_run_id is
  'Canonical research run whose lifecycle keeps this Direct thread visible in Working.';
