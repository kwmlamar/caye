-- 2026-07-21 — add a 4th placeholder to caye_morning_digest carrying the
-- once-daily "still aging" escalation list (see
-- app/api/caye/morning-digest/route.ts's buildAgingEscalationsSummary and
-- decisions-log.md 2026-07-21). This replaces the standalone
-- escalation_followup ping that used to fire one separate WhatsApp text
-- per stale escalation — confirmed live on Bimini/Karenda as a wall of
-- near-identical texts hitting her phone.
--
-- {{4}} is a single pre-formatted string, blank when nothing is aging
-- (e.g. "Oldest waiting: Jeff Dworkin — 6d, Charlene Volmy — 2d, and 2
-- more." or ""). Editing an already-approved template's body resets it to
-- Meta review — same pattern as the driver template body fixes
-- (20260705c/d/e) — so this flips back to 'pending' until re-approved.
-- The old approved body keeps serving live sends until then; the code
-- path already degrades gracefully (outbound-worker leaves the 4th
-- placeholder blank when there's nothing aging, and the held-count digest
-- itself is unaffected either way).

update public.whatsapp_templates
set
  body_template = 'Morning, {{1}}. {{2}} held for you, {{3}} bookings today.{{4}} Reply ''show'' for details.',
  placeholder_count = 4,
  status = 'pending',
  last_synced_at = now()
where name = 'caye_morning_digest';
