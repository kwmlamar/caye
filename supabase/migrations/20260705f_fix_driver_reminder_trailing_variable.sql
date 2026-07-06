-- 2026-07-05 — fix caye_driver_reminder trailing-variable rejection.
-- Meta blocks templates that end on a variable even with trailing
-- punctuation only ("...at {{4}}." doesn't count as real trailing text).
-- Added real words on both ends. Same 4 variables, same order. Still
-- pending submission.

update public.whatsapp_templates
set body_template =
  'Reminder for {{1}} — you have a pickup for {{2}} in about an hour: {{3}} at {{4}}. Please be on time!'
where name = 'caye_driver_reminder';
