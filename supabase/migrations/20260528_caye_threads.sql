create table caye_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references customers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on caye_threads(workspace_id, updated_at desc);
create index on caye_threads(user_id);

create table caye_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references caye_threads(id) on delete cascade,
  role text not null check (role in ('user', 'caye')),
  content text not null,
  cards jsonb,
  created_at timestamptz not null default now()
);
create index on caye_messages(thread_id, created_at);

alter table caye_threads enable row level security;
alter table caye_messages enable row level security;

create policy "users access their own threads"
  on caye_threads for all
  using (user_id = auth.uid());

create policy "users access messages in their threads"
  on caye_messages for all
  using (thread_id in (select id from caye_threads where user_id = auth.uid()));
