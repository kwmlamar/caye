-- Founder ad-hoc research investigations on the canonical Research Runtime.
--
-- This deliberately extends research_questions instead of introducing a second
-- investigation lifecycle. Founder assertions remain unverified leads attached
-- to a question origin; only research_runs may later produce research_claims.

alter table public.research_questions
  add column if not exists canonical_key text;

create unique index if not exists research_questions_one_current_canonical_key_idx
  on public.research_questions (canonical_key)
  where canonical_key is not null and status <> 'archived';

create table if not exists public.research_question_origins (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.research_questions(id) on delete cascade,
  founder_user_id text not null,
  source_workspace_id text not null,
  direct_thread_id text not null,
  inbound_message_id text not null,
  original_wording text not null,
  lead_text text not null,
  verification_question text not null,
  created_at timestamptz not null default now(),
  unique(question_id, inbound_message_id)
);

create index if not exists research_question_origins_question_created_idx
  on public.research_question_origins(question_id, created_at desc);

alter table public.research_question_origins enable row level security;
revoke all on public.research_question_origins from anon, authenticated;

comment on column public.research_questions.canonical_key is
  'Stable model-supplied subject/relation key used only for idempotent question reuse; never evidence that the lead is true.';
comment on table public.research_question_origins is
  'Trusted founder Direct provenance for canonical research questions. lead_text/original_wording are unverified inputs, not research claims.';
