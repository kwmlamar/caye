create table if not exists public.founder_notification_preferences (
  founder_user_id uuid primary key references auth.users(id) on delete cascade,
  whatsapp_enabled boolean not null default false,
  min_escalation_level integer not null default 5 check (min_escalation_level between 0 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.founder_notification_preferences enable row level security;

revoke all on public.founder_notification_preferences from anon;
revoke all on public.founder_notification_preferences from authenticated;
