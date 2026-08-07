-- 2026-08-07 — caye_escalations.brief
--
-- Adds the composed operator brief (lib/operator-brief.ts) alongside the
-- existing internal_context. Before this, the only thing an escalated
-- thread carried for the operator was internal_context — a 280-char prose
-- excerpt of the raw inbound (see forced-escalation.ts's build()) or, for
-- LLM-driven escalate_to_team calls, the model's handoff note. Neither
-- carries the calendar-availability check or the "what was already sent to
-- the customer" line that make a handoff actionable, and for structured
-- web-form submissions (Web3Forms etc.) the raw excerpt is machine syntax
-- ("Name: Robert Email: ... Phone: ...") that dies mid-field at 280 chars.
--
-- `brief` is the full multi-line message get_held_queue now hands to Caye
-- and the outbound worker sends free-form when the operator's WhatsApp
-- window is open. Nullable — legacy rows and any escalation path that
-- hasn't been updated to compute one yet fall back to internal_context.

alter table public.caye_escalations
  add column if not exists brief text;

comment on column public.caye_escalations.brief is
  'Composed operator brief (lib/operator-brief.ts) — full multi-line handoff message. Null falls back to internal_context.';
