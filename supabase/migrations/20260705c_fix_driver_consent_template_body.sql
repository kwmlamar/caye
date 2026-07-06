-- 2026-07-05 — fix caye_driver_consent body (Meta rejects reusing a
-- placeholder twice in one template body — {{2}} appeared twice in the
-- original seed). Still pending submission, so this just corrects the
-- local registry to match what's actually being typed into Meta's editor.

update public.whatsapp_templates
set body_template =
  'Hi {{1}} — it''s Caye, {{2}}''s AI assistant. They added you so I can reach out about tour pickups. Reply OK and I''ll have you set up.'
where name = 'caye_driver_consent';
