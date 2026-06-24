-- Per-call-site LLM spend attribution (#49).
--
-- Every wrapped client.messages.create writes one row. Aggregates by
-- source answer "which file is 60% of today's bill" without log grepping.
--
-- Tokens stored raw; cost computed on read in /api/admin/llm-spend so
-- pricing changes don't require backfill.

create table if not exists public.llm_call_log (
  id bigserial primary key,
  source text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_creation_tokens int not null default 0,
  workspace_id uuid,
  called_at timestamptz not null default now()
);

create index if not exists llm_call_log_called_at_idx
  on public.llm_call_log (called_at desc);

create index if not exists llm_call_log_source_called_at_idx
  on public.llm_call_log (source, called_at desc);

-- RLS: service role only. No customer- or operator-facing query path.
alter table public.llm_call_log enable row level security;
