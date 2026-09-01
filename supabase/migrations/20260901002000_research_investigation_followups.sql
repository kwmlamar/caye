-- Bounded decomposition/provenance for durable canonical research investigations.
-- These fields directly drive child creation, root-scoped dedupe/budgets, and
-- independent cross-check behavior in the existing research worker.

alter table public.research_questions
  add column if not exists parent_question_id uuid references public.research_questions(id) on delete set null,
  add column if not exists root_question_id uuid references public.research_questions(id) on delete set null,
  add column if not exists investigation_origin text not null default 'canonical'
    check (investigation_origin in ('canonical', 'founder', 'autonomous_signal', 'autonomous_followup', 'autonomous_cross_check')),
  add column if not exists max_autonomous_followups integer not null default 6
    check (max_autonomous_followups between 0 and 20);

create index if not exists research_questions_root_investigation_idx
  on public.research_questions (root_question_id, created_at)
  where root_question_id is not null;

create index if not exists research_questions_parent_investigation_idx
  on public.research_questions (parent_question_id, created_at)
  where parent_question_id is not null;

comment on column public.research_questions.parent_question_id is
  'Immediate canonical investigation that produced this bounded follow-up or cross-check.';
comment on column public.research_questions.root_question_id is
  'Root investigation used for root-scoped follow-up budgets and duplicate suppression.';
comment on column public.research_questions.investigation_origin is
  'Creation provenance that also drives runtime behavior; autonomous_cross_check excludes source URLs already observed by its parent.';
comment on column public.research_questions.max_autonomous_followups is
  'Hard root-scoped cap on autonomously created child questions. Zero prevents further decomposition.';
