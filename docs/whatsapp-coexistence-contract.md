# WhatsApp coexistence — verified provider contract and open questions

Companion to `briefs/whatsapp-coexistence-ingestion.md`. The brief states what
the product must do; this records what Meta was actually verified to send, and
what remains unestablished. Anything not listed as verified here was NOT
assumed by the code.

Verified 2026-09-02 against:

- Meta for Developers — *Onboard WhatsApp Business app users*
  <https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/>
- Meta for Developers — *smb_message_echoes webhook reference*
  <https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes>

## Webhook fields

Coexistence adds three fields alongside the ordinary `messages` field, all
delivered to the same endpoint inside the standard
`entry[].changes[].{value,field}` envelope:

| field | carries | status in this milestone |
| --- | --- | --- |
| `messages` | Cloud API inbound messages and delivery statuses | ingested (existing path, unchanged) |
| `smb_message_echoes` | messages the business sent from the WhatsApp Business app or a linked companion device | ingested, observe-only |
| `history` | past messages, only after the business approves chat-history sharing during onboarding | recognised, deliberately not ingested |
| `smb_app_state_sync` | the business's contacts and later changes to them | recognised, deliberately not ingested |

## `smb_message_echoes` shape

```
value.messaging_product = "whatsapp"
value.metadata          = { display_phone_number, phone_number_id }
value.message_echoes[]  = { from, to, id, timestamp, type, <type>: { ... } }
```

`type` ∈ `text` | `image` | `video` | `document` | `revoke` | `edit`.

```
revoke: { original_message_id }
edit:   { original_message_id, message: { type, <type>: { ... } } }
```

`from` is the business number and `to` is the WhatsApp user — the opposite of
an inbound `messages` entry. The customer side (`to`) is what keys the
canonical conversation, so an echo and the customer's own replies share one
thread.

## Unresolved — deliberately not guessed

1. **Does a Cloud API send also produce an echo?** Meta documents echoes as
   reporting WhatsApp Business app and companion-device sends and does not say
   either way about Cloud API sends. The code therefore does not assume:
   `echoMatchesRecordedCayeSend` reconciles each echo against sends Caye
   recorded, and only an unmatched echo is attributed to the human operator.
   Reconciliation depends on Meta's `wamid` being stored, which this change
   starts doing (`unified_messages.metadata.wa_message_id`). Sends that
   predate it cannot be matched, so an echo of an old Caye send would be
   recorded as human-authored. It would still never trigger a reply.

2. **A `messages`-field entry whose `from` is the business's own number.**
   Not a documented coexistence shape. It carries no `to`, so its thread is
   unknowable. Classified `unknown_business_origin`: audited on
   `workspace_events` at `actor_kind='unknown'`, never replied to, and never
   given a fabricated conversation.

3. **Media echo payload details.** Descriptors are preserved (type, and the
   provider's media node is left intact on the wire) but media download and
   artifact ingestion for echoes is not implemented. Follow-up.

4. **Bounded history import.** `history` is a separate ingestion slice. Live
   webhook ingestion does not depend on it.

## Follow-ups identified, not done here

- Media/artifact ingestion for echoed images, documents and voice notes.
- `history` import as its own bounded path with its own idempotency.
- Whether an owner's Business App reply should clear an open
  `human_agent_enabled` hold. The email path does this with
  `ownerReplyAddressesHold`; this milestone deliberately changes no hold
  state, so observation cannot resume automation on a thread the owner is
  handling.
- Whether `hasOperatorParticipatedInConversation` should count a message the
  operator personally wrote (`metadata.authored_by === 'human'`) as
  participation, not only an operator-approved Caye send. That would change
  notification suppression for the email path too, so it is its own change.
