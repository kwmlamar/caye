-- Founder-only engineering work. Binaries live in the private
-- engineering-artifacts Storage bucket, never in Postgres.
create table if not exists public.engineering_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  originating_thread_id uuid not null references public.caye_direct_threads(id) on delete restrict,
  originating_message_id uuid references public.caye_operator_messages(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  task_type text not null check (task_type in ('create_parametric_part','revise_parametric_part')),
  parameters jsonb not null,
  assumptions jsonb not null default '[]'::jsonb,
  runtime text not null default 'cadquery',
  provenance jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now()
);
create index if not exists engineering_jobs_workspace_thread_idx on public.engineering_jobs(workspace_id, originating_thread_id, created_at desc);

create table if not exists public.engineering_artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.customers(id) on delete cascade,
  job_id uuid not null references public.engineering_jobs(id) on delete restrict,
  parent_artifact_id uuid references public.engineering_artifacts(id) on delete restrict,
  revision integer not null check (revision > 0),
  name text not null,
  parameters jsonb not null,
  assumptions jsonb not null default '[]'::jsonb,
  dimensions jsonb not null default '{}'::jsonb,
  calculation_metadata jsonb not null default '{}'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, name, revision)
);
create index if not exists engineering_artifacts_workspace_idx on public.engineering_artifacts(workspace_id, created_at desc);

create table if not exists public.engineering_artifact_files (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.engineering_artifacts(id) on delete cascade,
  kind text not null check (kind in ('source','preview_geometry','export_geometry','metadata')),
  storage_path text not null,
  media_type text not null,
  byte_size integer not null check (byte_size >= 0 and byte_size <= 26214400),
  checksum text not null,
  created_at timestamptz not null default now(),
  unique (artifact_id, kind)
);

alter table public.engineering_jobs enable row level security;
alter table public.engineering_artifacts enable row level security;
alter table public.engineering_artifact_files enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('engineering-artifacts', 'engineering-artifacts', false, 26214400,
  array['text/x-python','application/sla','model/step','application/json'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- Only server routes use the service role for this V1; no browser policy grants
-- raw object access. Signed URLs are minted after a founder + workspace check.
