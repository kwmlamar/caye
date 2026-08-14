-- Send authorization can expire while the work remains a durable conversational
-- referent. Record when the operator completes that work outside Caye so every
-- reminder/scan can distinguish it from an abandoned authorization.
alter table public.caye_pending_actions
  add column if not exists owner_handled_at timestamptz,
  add column if not exists owner_handled_by_operator_id bigint references public.operator_allowlist(id) on delete set null,
  add column if not exists owner_handled_note text;

comment on column public.caye_pending_actions.owner_handled_at is
  'When an operator reported completing the staged task outside Caye. Does not authorize or execute the staged action.';

create index if not exists caye_pending_actions_owner_task_idx
  on public.caye_pending_actions (workspace_id, operator_id, created_at desc)
  where executed_at is null and owner_handled_at is null;
