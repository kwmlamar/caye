-- 2026-07-23 — extend the driver-consent pattern (2026-07-05b, grilled) to
-- owner/staff team members: a fixed "Reply OK" consent ask instead of a
-- random 6-digit OTP. Same reasoning as the driver case — the OTP wasn't
-- protecting anything a friendlier consent ask doesn't already; a
-- wrong-number stranger who receives either message can just as easily
-- echo back 6 digits as type "OK".
--
-- Can't reuse caye_otp for this: it's an 'authentication' category
-- template, and Meta restricts those to an actual generated code (no
-- custom body). Can't reuse caye_driver_consent either — its approved
-- wording ("added you as a driver contact for pickup notifications") is
-- wrong for owner/staff. New utility-category template, worded like
-- caye_driver_consent's final (Meta-approved) form so it reads as account
-- setup rather than marketing.

insert into public.whatsapp_templates (name, category, body_template, placeholder_count, status)
values
  (
    'caye_team_consent',
    'utility',
    'Hi {{1}} — this is Caye, {{2}}''s scheduling assistant. You''ve been added as a team member with back-office access. Reply OK to confirm.',
    2,
    'pending'
  )
on conflict (name) do nothing;
