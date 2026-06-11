# Brief — Intent classifier → tool-use migration

Documenting where each legacy operator intent (`lib/whatsapp/intent.ts`) now lives in the back-office agent's tool surface. The classifier is **not yet deleted** — see Backwards-compat section below.

## Mapping

| Legacy intent kind | New tool | Notes |
|---|---|---|
| `send` | (covered by held notification template + send_reply confirmation) | Operator typing "send" alone is a contextual reply to a Caye-sent draft. Back-office Caye now drafts + asks "send?" itself; standalone "send" only makes sense if the held notification format keeps the "reply send/skip" instruction. See below. |
| `skip` | `skip_held_item` | Operator provides the conversation_id (or names the customer; Caye looks up via `search_threads`). |
| `edit` | (covered by `send_reply` with a new body) | Operator's edit instruction becomes a new draft. Caye composes the revised text and confirms, then `send_reply` ships it. |
| `handled` | `mark_handled` | Same mechanic; the agent confirms it understood which thread. |
| `query` | (any read tool — `get_held_queue`, `get_calendar`, `get_today_summary`, etc.) | Already migrated in slice #36. Operator questions route to back-office agent, which picks the right read tool. |
| `mute` | `mute_caye` | Same arguments (duration_hours / until_iso). |
| `unmute` | `unmute_caye` | Same. |
| `multi` | (multiple sequential tool calls) | Operator batches by naming multiple items; back-office Caye calls `mark_handled` / `skip_held_item` for each. Less efficient but fewer lines of code to maintain. |
| `unclear` | (back-office Caye conversational handling) | Migrated in slice #36 — Caye asks for clarification in her own voice. |

## What's deleted, what stays

**Stays for now:**
- `lib/whatsapp/intent.ts` — still imported by `app/api/webhooks/whatsapp-operator/route.ts`.
- `lib/whatsapp/actions/` — `send`, `skip`, `edit`, `handled`, `mute`, `unmute`, `multi` handlers still wired.
- The classifier-dispatch path in the webhook for kinds in `LEGACY_DISPATCH_KINDS`.

**Why not delete yet — backwards-compat risk:**

Held-item notification text (`lib/whatsapp/triggers.ts` → outbound queue → operator's phone) instructs the operator to **"Reply send/skip/edit"**. That instruction wires directly into the classifier. If we delete the classifier today, those single-word replies fall to back-office Caye, which would need to figure out the context herself.

Back-office Caye CAN handle it (the sliding-window history shows the prior notification, so "send" in response is interpretable). But:

1. Confirmation latency: classifier round-trips a held action in ~500ms. Back-office Caye round-trips in ~3-5s (two Claude calls).
2. Brittleness: Claude has to reliably correlate "send" → the prior held notification → call `send_reply`. Works in testing but may misfire under noisy contexts.

**Cleanest cutover:** update the held notification template to NOT instruct shortcut replies. Instead, the notification ends with "DM me to act on this" or similar conversational hook. Then back-office Caye handles everything. Track as follow-up issue.

## When this brief is done

Once the held notification templates are updated and back-office latency is acceptable for action confirmations:
- Delete `lib/whatsapp/intent.ts`
- Delete `lib/whatsapp/actions/`
- Remove the `LEGACY_DISPATCH_KINDS` branch from the operator webhook
- Verify no regression on the held-queue management flow with a real pilot
- Close epic #35 / slice #44

For now, the classifier is dead-quiet for `query` and `unclear` (zero traffic — that all routes to back-office) but still active for the action shortcuts.
