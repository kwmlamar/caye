-- Founder Settings card (2026-07-24, grilled) — morning_digest currently
-- fires every single day with no per-workspace override; nextDigestTime()
-- (lib/whatsapp/schedule.ts) always computes "next 7am" with no day-of-
-- week concept anywhere. digest_days lets a workspace narrow which local
-- weekdays it sends on. 0=Sunday..6=Saturday (JS/Postgres getUTCDay-style,
-- but evaluated in the workspace's local timezone, not UTC — see
-- localDayOfWeek in schedule.ts). Defaults to every day so nothing changes
-- for any existing workspace (Bimini/Karenda included) until explicitly
-- narrowed from the dashboard.
alter table workspace_ai_config
  add column if not exists digest_days smallint[] not null default '{0,1,2,3,4,5,6}';

comment on column workspace_ai_config.digest_days is
  'Local weekdays (0=Sun..6=Sat) the morning_digest WhatsApp ping sends on. Default is every day (unchanged behavior). Distinct from owner_only_weekdays, which is a booking/operating-rules concept, not a notification schedule.';
