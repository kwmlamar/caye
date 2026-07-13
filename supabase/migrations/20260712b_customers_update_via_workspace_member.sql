-- Workspace-first signup (WhatsApp cold-start) means a workspace's owner
-- (workspace_members.user_id) can now differ from customers.id — the two
-- are only guaranteed equal for the old OAuth-created-workspace path.
-- customers UPDATE previously only allowed auth.uid() = id, which broke
-- client-side writes (ProfilePanel avatar, CayeAIPanel auto-reply toggle)
-- for any dashboard access granted via the claim flow. Mirrors the
-- existing "Workspace members can view workspace customer" SELECT policy.

create policy "Workspace members can update workspace customer"
on public.customers for update
using (id in (select workspace_id from workspace_members where user_id = auth.uid()))
with check (id in (select workspace_id from workspace_members where user_id = auth.uid()));
