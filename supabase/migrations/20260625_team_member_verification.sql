-- 2026-06-25 — team member verification (#55)
--
-- Extends operator_allowlist with verification metadata so add_team_member
-- can create a row that doesn't grant access until the new member proves
-- they own the phone (replies to Caye's OTP).
--
-- Backwards compatible: existing rows (the owner backfill from #48 and
-- the founder auto-insert trigger) are set verified_at = now() so they
-- keep working. New rows from add_team_member start with verified_at
-- NULL + pending_otp_* populated.
--
-- The whatsapp-operator webhook lookup is extended in code to treat
-- verified_at IS NULL rows specially: any message body matching the
-- pending OTP code verifies the member; otherwise the message is
-- dropped (no leaking back-office access to an unverified phone).

alter table public.operator_allowlist
  add column if not exists name text,
  add column if not exists verified_at timestamptz,
  add column if not exists pending_otp_code text,
  add column if not exists pending_otp_expires_at timestamptz,
  add column if not exists added_by text;

-- Existing rows are pre-verified — they were either backfilled from the
-- legacy operator_whatsapp_number column or auto-inserted as founder by
-- the trigger. Both paths are trusted.
update public.operator_allowlist
  set verified_at = coalesce(verified_at, created_at)
  where verified_at is null;

-- The trigger from #48 needs to keep founders pre-verified too. Patch it
-- in place — same body, just adds verified_at on insert.
create or replace function public.ensure_founder_in_allowlist()
  returns trigger
  language plpgsql
  security definer
as $$
declare
  fp text;
begin
  select value into fp from public.platform_settings where key = 'founder_phone';
  if fp is not null and length(fp) > 0 then
    insert into public.operator_allowlist (workspace_id, phone, role, verified_at)
      values (new.id, fp, 'founder', now())
    on conflict (workspace_id, phone) do nothing;
  end if;
  return new;
end;
$$;

comment on column public.operator_allowlist.verified_at is
  'Set when the member has proven phone ownership by replying to the OTP. Rows with verified_at IS NULL are inert — the webhook drops their messages until they verify.';
comment on column public.operator_allowlist.pending_otp_code is
  'The 6-digit code sent via caye_otp template. Cleared on successful verification or expiry.';
