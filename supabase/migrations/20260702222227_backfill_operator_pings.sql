-- 2026-07-02 — backfill historical operator pings into caye_operator_messages
--
-- Escalation/urgent-hold/digest pings were sent over real WhatsApp via
-- caye_outbound_queue but never mirrored into caye_operator_messages, so
-- they never showed up in Caye Direct's thread view — the exact gap that
-- made it look like Caye never actually followed up with Karenda about
-- things like the Jeff Dworkin escalation. The outbound-worker now logs
-- these going forward (resolveOpenEscalations/logOperatorPing); this
-- backfills the already-sent history so the record is complete.
--
-- NOTE: applied directly to the live project (fetsfbdltlxjsomiqvrw) on
-- 2026-07-02 but never committed to this directory until 2026-08-13 — see
-- 20260702214041_operator_message_identity.sql for the drift note. This
-- file documents already-live state; it does not change production.
with resolved as (
  select
    q.id as queue_id,
    q.workspace_id,
    q.kind,
    q.payload,
    q.sent_at,
    coalesce(q.payload->>'to_phone', wac.operator_whatsapp_number) as phone
  from caye_outbound_queue q
  join workspace_ai_config wac on wac.workspace_id = q.workspace_id
  where q.status = 'sent'
    and q.kind in ('urgent_hold','escalation','escalation_followup','same_day_booking','morning_digest','auth_failure')
),
matched as (
  select
    r.*,
    oa.id as operator_id,
    oa.name as operator_name,
    oa.role as operator_role
  from resolved r
  left join lateral (
    select id, name, role from public.operator_allowlist oa
    where oa.workspace_id = r.workspace_id
      and (oa.phone = r.phone or oa.phone = ('+' || r.phone) or ('+' || oa.phone) = r.phone)
    limit 1
  ) oa on true
)
insert into public.caye_operator_messages
  (workspace_id, direction, wa_message_id, body, intent, operator_allowlist_id, operator_name, operator_role, created_at)
select
  workspace_id,
  'outbound',
  null,
  case kind
    when 'urgent_hold' then '[Held for you] ' || coalesce(payload->>'contactName', 'A guest') || ' — ' || coalesce(payload->>'reason', 'needs your call')
    when 'escalation' then '[Escalated] ' || coalesce(payload->>'contactName', 'A guest') || ' — ' || coalesce(nullif(payload->>'ping_summary', ''), payload->>'internalContext', 'needs your call')
    when 'escalation_followup' then '[Still waiting] ' || coalesce(payload->>'contactName', 'A guest') || ' — ' || coalesce(nullif(payload->>'ping_summary', ''), coalesce(payload->>'category', 'policy') || ' escalation')
    when 'same_day_booking' then '[Same-day booking] ' || coalesce(payload->>'guest', 'A guest') || ' booked for today.'
    when 'morning_digest' then '[Digest] ' || coalesce(payload->>'heldCount', '0') || ' held, ' || coalesce(payload->>'bookingsTodayCount', '0') || ' booked today.'
    when 'auth_failure' then '[Connection issue] ' || coalesce(payload->>'service', 'A connected service') || ' needs reconnecting.'
    else '[' || kind || ']'
  end,
  null,
  operator_id,
  operator_name,
  operator_role,
  sent_at
from matched;
