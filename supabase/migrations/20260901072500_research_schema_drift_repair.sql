-- Repair research schema drift exposed by the OpenAI research runtime.
-- Idempotent by design so environments that already applied the underlying
-- lifecycle/founder-surface migrations remain unchanged.

alter table public.research_questions
  add column if not exists parent_question_id uuid references public.research_questions(id) on delete set null,
  add column if not exists root_question_id uuid references public.research_questions(id) on delete set null,
  add column if not exists investigation_origin text not null default 'canonical',
  add column if not exists max_autonomous_followups integer not null default 6,
  add column if not exists last_founder_surface_fingerprint text,
  add column if not exists last_founder_surface_confidence double precision,
  add column if not exists last_founder_surface_at timestamptz;

create index if not exists research_questions_root_investigation_idx
  on public.research_questions (root_question_id, created_at)
  where root_question_id is not null;
create index if not exists research_questions_parent_investigation_idx
  on public.research_questions (parent_question_id, created_at)
  where parent_question_id is not null;

-- Runtime classifications introduced after research_runtime_v1 were broader
-- than the original database check. Keep legacy values readable while allowing
-- the deterministic current classifier to persist evidence.
alter table public.research_sources
  drop constraint if exists research_sources_quality_check;
alter table public.research_sources
  add constraint research_sources_quality_check check (
    quality = any (array[
      'primary'::text,
      'peer_reviewed'::text,
      'original_repo'::text,
      'independent'::text,
      'official'::text,
      'academic-preprint'::text,
      'academic-institution'::text,
      'community'::text,
      'unknown'::text
    ])
  );

-- Re-assert the newer semantic constraints where a drifted environment may
-- have gained columns outside the original migrations.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'research_questions_investigation_origin_check') then
    alter table public.research_questions add constraint research_questions_investigation_origin_check
      check (investigation_origin in ('canonical','founder','autonomous_signal','autonomous_followup','autonomous_cross_check'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'research_questions_max_autonomous_followups_check') then
    alter table public.research_questions add constraint research_questions_max_autonomous_followups_check
      check (max_autonomous_followups between 0 and 20);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'research_questions_last_founder_surface_confidence_check') then
    alter table public.research_questions add constraint research_questions_last_founder_surface_confidence_check
      check (last_founder_surface_confidence is null or last_founder_surface_confidence between 0 and 1);
  end if;
end $$;
