-- checkStaleDeliveryAndAlert (app/api/caye/outbound-worker/route.ts) marks
-- rows with no Meta delivery callback after 15 minutes as
-- wa_delivery_status='timeout' — a synthetic value distinct from Meta's
-- real sent/delivered/read/failed, so a row is never rescanned once
-- retired. The original check constraint (20260725_outbound_delivery_status)
-- only allowed Meta's four real values, so every one of those updates
-- silently violated it and no-opped (the JS code didn't check the update's
-- error return). Confirmed live 2026-07-26: ~134 rows sat permanently
-- un-retired, re-scanned and re-alerted (once per hour, per the alert's own
-- dedup) every tick instead of once ever.

alter table caye_outbound_queue drop constraint caye_outbound_queue_wa_delivery_status_check;
alter table caye_outbound_queue add constraint caye_outbound_queue_wa_delivery_status_check
  check (wa_delivery_status = any (array['sent', 'delivered', 'read', 'failed', 'timeout']));
