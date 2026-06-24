# Front-desk tool coverage audit (#58) — walkthrough scaffold

> **Status: HITL scaffold only.** Per #58, the actual audit needs owner-day
> judgment ("would Karenda actually use this tool? Does the wording match
> her habits?"). The agent has staged the format + the v1 tool inventory +
> the walkthrough prompts. Lamar fills the rows, then files follow-up
> issues per gap with `needs-triage`.

---

## v1 tool inventory (post-Phase 4)

Use this as the column-header reality check when scoring each step below.

### Front-desk tools (inline in `lib/caye-reply.ts`)
- `check_availability`
- `create_booking`
- `send_reply` (now with required `confidence: high|medium|low`)
- `lookup_price`
- `find_bookings`
- `cancel_booking`
- `reschedule_booking`
- `hold_for_human`
- `escalate_to_team` *(category: gap | policy | knowledge | sensitive; route: owner | founder | both)*

### Layer 1 deterministic triggers (`lib/forced-escalation.ts`)
- Complaint (classifier or Haiku second-pass)
- B2B / partnership / commercial-terms
- Refund / money-back language
- Custom / private / exception requests

### Back-office tools (`lib/caye-agent/tools/`, accessible via the Caye-owned WhatsApp number)
**Read:** get_calendar, get_held_queue, get_today_summary, get_revenue,
get_customer, get_customer_history, get_recent_activity, get_recent_bookings,
get_pending_quotes, search_threads, query_business_knowledge

**Write-low:** mark_handled, skip_held_item, mute_caye, unmute_caye,
archive_thread, add_internal_note, add_business_fact, update_service_price,
add_service, set_service_visibility, update_business_hours, add_blackout_date,
update_voice_register, add_voice_sample, add_team_member,
update_team_member_permissions

**Write-high (gated):** send_reply, confirm_booking, reschedule_booking,
cancel_booking, remove_service, remove_blackout_date, remove_team_member

---

## Bimini operating-day walkthrough

Karenda's representative weekday — fill the table below as you walk through
a real Tuesday from Bimini pulse. Goal: every step Caye should handle without
"Caye said she can't."

**Suggested day shape** (lift from Clients/bimini-island-tours.md history):
- ~6 inbound emails (mix of new inquiries, repeat customer, vague availability question)
- 1 phone follow-up needed (booking confirmation handoff)
- 1 booking confirmation to send
- 1 partial pricing question (customer named a service but no group size)
- 1 off-menu request (customer asks for a tour combo we don't list)
- 1 Sunday-only booking ask (must defer to Karenda per blackout schedule)

### Walkthrough table

For each step: identify the action, name the tool that covers it, OR mark it as
a gap. `add_business_fact` and `escalate_to_team` count as graceful coverage —
they're escape hatches by design.

| # | Step (what happens) | Tool that covers it | Graceful via escape hatch? | Gap? (Y/N) | Notes |
|---|---------------------|----------------------|---------------------------|------------|-------|
| 1 | Email lands: new inquiry, names "North Bimini Heritage Tour", asks for Sat | check_availability + lookup_price + send_reply | — | N | baseline path |
| 2 | Email lands: returning customer, vague "got time next week?" | send_reply (clarify) | — | ? | does CLARIFY pattern feel natural to Karenda? |
| 3 | Email lands: complaint about prior trip | Layer 1 forced → escalate_to_team(policy → owner) | — | ? | fill empathy template language quality |
| 4 | Email lands: B2B agency wanting wholesale rates | Layer 1 forced → escalate_to_team(sensitive → owner) | — | ? | |
| 5 | Email lands: customer asks "what's included in the Bimini Beach Experience?" and the answer isn't in catalog description | query_business_knowledge → if hit, send_reply; if miss → escalate(knowledge → owner) | escalate_to_team | ? | first run will likely escalate; owner answer captured for next time |
| 6 | Email lands: customer names a service we don't have ("Sunset Snorkel") | send_reply (2B mode: acknowledge + qualify + flag_for_owner_followup) | — | ? | does 2B feel natural here? |
| 7 | Sunday booking inquiry | check_availability returns owner_only → send_reply | — | N | already covered by operating-rules.ts |
| 8 | Karenda needs to add a one-off vacation: Aug 14–20 | add_blackout_date | — | N | conversational |
| 9 | Karenda raises Sit-Low private to $199 | update_service_price | — | N | |
| 10 | Karenda adds Max to allowlist | add_team_member | — | N | OTP gate validates |
| 11 | <add real step from a Karenda day> | | | | |
| 12 | <add real step from a Karenda day> | | | | |

---

## ODS hypothetical walkthrough

Per #58: a dad-asks-Caye scenario + a status-question customer inquiry. ODS is
demo-parked (memory `project_ods_blueprint_takeoff_skill`), so this is
prospective coverage — no live data to walk against.

### Scenario A — Dad asks Caye (back-office)
- Dad: "What's the status on the Spanish Wells villa?"
- Tool path: get_recent_activity / get_recent_bookings / search_threads? Or is
  this a different domain (construction projects, not bookings)?
- **Likely gap:** ODS construction projects don't map to the bookings schema.
  Either (a) defer ODS to its own repo (matches the parked decision) or
  (b) generalize get_recent_activity to read from a future `projects` table.

### Scenario B — Customer asks ODS Caye for status
- Customer: "Hi, just checking if the foundation pour is still scheduled for
  Thursday?"
- Tool path: would need a project_status read tool + a notify_homeowner write
  tool. Neither exists in v1.
- **Likely gap:** entire construction surface unmodeled.

| # | Step | Tool that covers it | Graceful via escape hatch? | Gap? | Notes |
|---|------|---------------------|---------------------------|------|-------|
| A1 | Dad asks for villa status in back-office | — | escalate? doesn't make sense back-office | Y | needs project read tools |
| B1 | Customer asks foundation-pour status | — | escalate(knowledge → owner) | Y | needs project status surface |
| B2 | Customer asks to reschedule a site visit | — | escalate(policy → owner) | Y | needs project booking surface |

---

## Gap-list output format

When the walkthrough is done, fill this table and file one issue per row.

| Proposed tool name | Surface | Category | Frequency estimate | Priority | One-line description |
|--------------------|---------|----------|--------------------|----------|----------------------|
| _example_ get_meeting_point | front-desk read | knowledge | every booking | P1 | "Resolve the meeting point for a given service + date so Caye stops escalating logistics" |
| | | | | | |
| | | | | | |

**Issue template per gap:**
- Title: `Coverage gap: <action> — <proposed_tool_name>`
- Label: `needs-triage`
- Body: link back to this file + the row, plus the failing scenario from the walkthrough.

---

## Notes for the audit pass

- Treat `add_business_fact` + `escalate_to_team` as graceful coverage — they
  are escape hatches by design. A gap only counts when neither would feel
  natural OR the same gap would fire on every booking (high frequency =
  promote to a fine-grained tool per #51's promotion-loop spec).
- For each "send_reply (2B mode)" cell: judge whether the acknowledge-and-defer
  wording would actually land with Karenda's customers (Bahamian SMB context).
  If the tone is wrong, that's a voice-register issue (#54), not a tool gap.
- Wherever the answer is "Karenda would just text me herself instead of asking
  Caye to do it" — that is not a gap. The system is designed around
  back-office WhatsApp, not perfect autonomy.
