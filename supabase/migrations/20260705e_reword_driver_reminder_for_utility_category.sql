-- 2026-07-05 — reword caye_driver_reminder so Meta's category classifier
-- reads it as utility. Original phrasing ("{{2}}'s pickup is in about an
-- hour") framed the message around a third party's (the guest's)
-- appointment, which Meta's classifier read as marketing/informational
-- rather than "an existing order or account" belonging to the recipient.
-- Reframed around the driver's own task instead. Same 4 variables, same
-- order (driver name, guest name, tour, time). Still pending submission.

update public.whatsapp_templates
set body_template =
  'Reminder {{1}} — you have a pickup in about an hour for {{2}}: {{3}} at {{4}}.'
where name = 'caye_driver_reminder';
