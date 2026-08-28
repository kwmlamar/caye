-- Founder Direct threads become founder-scoped while every agent turn remains
-- explicitly attached to one active workspace. `workspace_id` stays as the
-- stable home/origin workspace for provenance and proactive subject reuse.

alter table public.caye_direct_threads
  add column if not exists scope_kind text not null default 'founder'
    check (scope_kind in ('founder')),
  add column if not exists active_workspace_id uuid references public.customers(id) on delete restrict,
  add column if not exists has_cross_workspace_context boolean not null default false;

update public.caye_direct_threads
set active_workspace_id = workspace_id
where active_workspace_id is null;

alter table public.caye_direct_threads
  alter column active_workspace_id set not null;

create index if not exists caye_direct_threads_founder_activity_idx
  on public.caye_direct_threads(scope_kind, status, last_activity_at desc);
create index if not exists caye_direct_threads_active_workspace_idx
  on public.caye_direct_threads(active_workspace_id, status, last_activity_at desc);

comment on column public.caye_direct_threads.workspace_id is
  'Stable home/origin workspace for provenance and Caye-initiated subject reuse. Not the current founder tool scope.';
comment on column public.caye_direct_threads.active_workspace_id is
  'Explicit workspace context for the next founder Direct turn. May change between turns; tool execution remains workspace-scoped.';
comment on column public.caye_direct_threads.scope_kind is
  'Conversation ownership scope. Founder Direct threads remain visible while the dashboard workspace changes.';
comment on column public.caye_direct_threads.has_cross_workspace_context is
  'True once this thread has operated in more than one workspace. Unscoped rolling summaries are suppressed for these threads to prevent cross-tenant fact conflation.';

-- Historical replay needs to know which workspace each founder message was
-- uttered in. Keep the visible body untouched, but prefix the persisted model
-- representation. Backfill existing founder-dashboard inbound rows first so
-- old Direct history is safe the moment a legacy thread crosses workspaces.
update public.caye_operator_messages m
set claude_format = jsonb_set(
  m.claude_format,
  '{content}',
  to_jsonb('[Founder Direct workspace: ' || coalesce(nullif(c.business_name, ''), m.workspace_id::text) || ']' || E'\n\n' || (m.claude_format->>'content')),
  false
)
from public.customers c
where c.id = m.workspace_id
  and m.origin = 'dashboard'
  and m.direction = 'inbound'
  and m.operator_role = 'founder'
  and m.claude_format is not null
  and jsonb_typeof(m.claude_format->'content') = 'string'
  and (m.claude_format->>'content') not like '[Founder Direct workspace:%';

create or replace function public.caye_scope_founder_direct_inbound()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  workspace_label text;
  original_content text;
begin
  if new.origin = 'dashboard'
     and new.direction = 'inbound'
     and new.operator_role = 'founder'
     and new.claude_format is not null
     and jsonb_typeof(new.claude_format->'content') = 'string' then
    original_content := new.claude_format->>'content';
    if original_content not like '[Founder Direct workspace:%' then
      select business_name into workspace_label from public.customers where id = new.workspace_id;
      workspace_label := coalesce(nullif(workspace_label, ''), new.workspace_id::text);
      new.claude_format := jsonb_set(
        new.claude_format,
        '{content}',
        to_jsonb('[Founder Direct workspace: ' || workspace_label || ']' || E'\n\n' || original_content),
        false
      );
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.caye_scope_founder_direct_inbound() from public, anon, authenticated;

drop trigger if exists caye_scope_founder_direct_inbound_guard on public.caye_operator_messages;
create trigger caye_scope_founder_direct_inbound_guard
before insert on public.caye_operator_messages
for each row execute function public.caye_scope_founder_direct_inbound();

-- The existing summary generator predates cross-workspace threads and emits a
-- single unscoped paragraph. Detect the first real context move in the DB,
-- make that fact durable, and thereafter refuse to persist a lossy summary.
-- Raw linked history remains durable and each founder inbound carries its
-- workspace marker above.
create or replace function public.caye_guard_cross_workspace_direct_summary()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.active_workspace_id is distinct from old.active_workspace_id then
    new.has_cross_workspace_context := true;
  end if;
  if new.has_cross_workspace_context then
    new.summary := null;
    new.summary_updated_at := null;
  end if;
  return new;
end;
$$;
revoke all on function public.caye_guard_cross_workspace_direct_summary() from public, anon, authenticated;

drop trigger if exists caye_guard_cross_workspace_direct_summary on public.caye_direct_threads;
create trigger caye_guard_cross_workspace_direct_summary
before insert or update of summary, summary_updated_at, has_cross_workspace_context, active_workspace_id
on public.caye_direct_threads
for each row execute function public.caye_guard_cross_workspace_direct_summary();
