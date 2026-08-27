-- Request-level metadata for measuring bounded agent-loop cost.
-- Nullable/additive by design: existing telemetry writers remain valid.

alter table public.llm_call_log
  add column if not exists request_id text,
  add column if not exists caller_role text,
  add column if not exists loop_iteration integer;

alter table public.llm_call_log
  drop constraint if exists llm_call_log_caller_role_check;

alter table public.llm_call_log
  add constraint llm_call_log_caller_role_check
  check (caller_role is null or caller_role in ('owner', 'staff', 'founder', 'driver'));

alter table public.llm_call_log
  drop constraint if exists llm_call_log_loop_iteration_check;

alter table public.llm_call_log
  add constraint llm_call_log_loop_iteration_check
  check (loop_iteration is null or loop_iteration > 0);

create index if not exists llm_call_log_request_id_idx
  on public.llm_call_log (request_id, called_at desc)
  where request_id is not null;

create index if not exists llm_call_log_caller_role_called_at_idx
  on public.llm_call_log (caller_role, called_at desc)
  where caller_role is not null;
