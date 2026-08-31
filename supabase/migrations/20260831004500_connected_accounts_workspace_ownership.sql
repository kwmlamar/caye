-- connected_accounts.user_id is historically named, but runtime semantics and RLS
-- treat it as a workspace/customer id. The old auth.users FK only worked when a
-- workspace id happened to equal its owner's auth user id, and rejected OAuth
-- connections for delegated/admin-managed workspaces.
--
-- Keep the column name for compatibility with existing readers/writers; repair
-- the referential contract so Gmail/Zoho callbacks can persist workspace-owned
-- channel connections.

alter table public.connected_accounts
  drop constraint if exists connected_accounts_user_id_fkey;

alter table public.connected_accounts
  add constraint connected_accounts_user_id_fkey
  foreign key (user_id)
  references public.customers(id)
  on delete cascade;

comment on column public.connected_accounts.user_id is
  'Workspace/customer id owning this connected account. Historical column name retained for compatibility.';
