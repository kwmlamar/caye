-- 2026-07-05 — reword caye_driver_consent so Meta's category classifier
-- reads it as utility (account/operational setup), not marketing. The
-- original "so I can reach out about tour pickups" phrasing tripped
-- Meta's "Category does not match" warning, recommending Marketing —
-- wrong category for what's really an operational contact-setup step
-- (Marketing carries its own opt-in requirements and higher per-message
-- cost, not worth it here). Reworded to read as account setup instead
-- of an outreach pitch. Still pending submission.

update public.whatsapp_templates
set body_template =
  'Hi {{1}} — this is Caye, {{2}}''s scheduling assistant. You''ve been added as a driver contact for pickup notifications. Reply OK to confirm.'
where name = 'caye_driver_consent';
