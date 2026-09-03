# WhatsApp Coexistence Ingestion

## Status

Implementation brief for `feat/whatsapp-coexistence-ingestion`.

This branch intentionally starts with the engineering contract before implementation so another Claude Code agent can pick it up without inventing product semantics.

## Goal

Allow a workspace owner to continue using the existing WhatsApp Business mobile app while Caye passively observes the business conversation stream available through Meta's supported coexistence/Cloud API path.

The first milestone is **observation and durable ingestion**, not autonomous action.

Caye should be able to distinguish and persist:

1. customer/partner messages received on the connected business number;
2. messages sent by the human business operator from the WhatsApp Business app when Meta exposes those messages through the supported coexistence webhook/event surface;
3. messages sent by Caye through the Cloud API;
4. delivery/read status callbacks.

Human-authored WhatsApp messages must not be mistaken for customer inbound messages or for Caye-authored outbound messages.

## Why this exists

ODS Construction conducts meaningful operational work over WhatsApp and phone. Important business state therefore never reaches Caye today.

The current customer WhatsApp webhook already ingests ordinary inbound Cloud API messages, but it has a self-loop guard that skips messages from the business's own number. That is correct for preventing reply loops in the current architecture, but coexistence introduces a new requirement: a human-authored business-app message may be valuable evidence even though Caye must **not** auto-reply to it.

This work should extend the existing WhatsApp ingestion architecture rather than create a second ODS-specific webhook stack.

## Product principles

- Dad/owner keeps using the normal WhatsApp Business mobile app.
- Caye observes instead of forcing a new operator UI.
- Human-authored messages are evidence, not automatically authoritative business truth.
- Preserve source, author, timestamp, message id, conversation identity, and ingestion provenance.
- Unknown/conflicting claims remain unknown/conflicting.
- Observation must not itself trigger an outbound reply.
- No ODS-specific parsing in the transport layer.
- No parallel attention or autonomy system.
- Reuse canonical contacts, conversations, domain events, evidence/intelligence, owner-attention, and autonomy primitives where appropriate.

## Current architecture to inspect first

At minimum inspect current `origin/main` implementations of:

- `app/api/webhooks/whatsapp/route.ts`
- `app/api/webhooks/whatsapp-operator/route.ts`
- `lib/whatsapp/`
- `lib/contacts/resolve-contact.ts`
- `lib/domain/`
- `lib/domain-events/`
- `lib/artifacts/`
- `lib/intelligence/`
- `lib/operational-intelligence/`
- `lib/owner-attention.ts`
- `lib/action-autonomy.ts`
- `lib/decision-authority.ts`

Do not assume this brief is newer than code. Current `origin/main` is authoritative.

## Required design

### 1. Normalize transport events before business logic

Introduce or strengthen a small WhatsApp webhook normalization boundary so downstream code can reason about message origin explicitly instead of inferring it from `from` alone.

A normalized observed message should represent, at minimum:

- Meta message id
- workspace / connected account
- business phone number id
- conversation/customer WhatsApp id where available
- observed timestamp
- message type
- text/media descriptor
- actor/origin classification
- raw-source provenance needed for audit/debugging without unnecessarily retaining secrets

Suggested origin vocabulary, subject to the actual Meta payload contract:

- `external_contact`
- `business_app_operator`
- `caye_cloud_api`
- `unknown_business_origin`

Do not hard-code guessed Meta fields. Verify the current supported coexistence webhook contract before implementing parser logic, and isolate provider-specific details inside the normalization layer.

### 2. Preserve the current anti-loop invariant

A message authored from the business app must never enter the customer auto-reply path.

The existing self-loop protection must become origin-aware rather than simply discarding potentially useful human-authored messages.

Expected behavior:

`external_contact` -> existing customer inbound handling may continue.

`business_app_operator` -> persist/observe only; update conversation state appropriately; never call `generateCayeAutoReply`; never send a WhatsApp response merely because the echo was observed.

`caye_cloud_api` -> avoid duplicate persistence if the outbound message was already stored by Caye; reconcile provider ids/status when possible.

`unknown_business_origin` -> fail closed for autonomous response. Persist enough evidence for audit if safe, but do not pretend authorship is known.

### 3. Human WhatsApp activity becomes provenance-preserving evidence

Where existing architecture supports it cleanly, human-authored business-app messages should be available to Caye's durable business-understanding layer.

Do not turn casual chat directly into authoritative project state.

For example, a human message saying `cistern is finished` may become an observed/source claim linked to the conversation/contact/project context when resolvable. It must not silently become a completed contractual milestone without corroboration or an appropriate authority rule.

Prefer existing domain-event/intelligence/provenance primitives. If a new general primitive is truly necessary, keep it channel-neutral.

### 4. Conversation continuity

Human app messages and external replies must land in the same canonical conversation when they belong to the same WhatsApp thread.

Do not create a duplicate conversation merely because one side was observed through coexistence.

Preserve `last_sender_type` / sender-kind semantics accurately. If existing schema cannot distinguish human-business from Caye-business safely, propose the smallest compatible extension and document why.

### 5. Historical sync is separate from live ingestion

Do not pretend this PR can import unlimited historical WhatsApp chats.

If Meta's supported coexistence onboarding exposes a bounded history sync, model that as a separate, explicit ingestion path or follow-up slice. Live webhook ingestion must work independently.

### 6. Media

Do not expand this PR into a giant media-processing rewrite.

If coexistence events can include images/documents/voice notes, preserve their descriptors and route through existing media/artifact infrastructure where already supported. Missing media capability should be identified as follow-up work rather than silently discarded.

## Tests / acceptance criteria

Add sanitized fixtures and tests for the actual supported payload shapes.

At minimum prove:

1. ordinary external inbound text still follows the existing customer path;
2. a human business-app coexistence message is persisted/observed but never generates an AI reply;
3. a Caye-originated message/event cannot loop back through the inbound auto-reply path;
4. duplicate provider events are idempotent;
5. unknown/unsupported origin fails closed for autonomous action;
6. delivery/read status handling remains intact;
7. conversation identity is stable across external and human-business activity;
8. no ODS-specific keyword or project logic is added to the webhook transport layer;
9. existing WhatsApp tests remain green;
10. typecheck/lint/build or the repository's required validation passes.

Use sanitized fixtures only. No live WhatsApp sends are required to validate this PR.

## Production safety

- NO production messages during development/testing.
- NO destructive production writes.
- NO Bedrock/TropiTrack writes.
- NO production migration unless the implementation proves one is necessary and the migration is independently reviewable.
- Never log access tokens, app secrets, webhook signatures, or raw credentials.
- Preserve signature verification.
- Unknown event shapes must fail safely.
- Do not weaken existing autonomous-action gates.

## Meta contract verification requirement

Before coding coexistence-specific parsing, verify the currently supported Meta/WhatsApp coexistence event contract from authoritative documentation or known real sanitized payloads.

If the exact human-app echo shape cannot be established, stop at the normalization interface + fixtures supported by evidence and report the missing contract. Do not invent fields because they sound plausible.

## ODS context request if needed

ODS-specific workflow interpretation is **not required** to implement the transport foundation.

If product behavior beyond passive observation is proposed, request concrete evidence rather than guessing. For example, ask for representative sanitized WhatsApp exchanges showing how Wallace communicates project completions, purchases, freight status, or approvals.

## Definition of done

This PR is done when Caye can safely observe supported WhatsApp coexistence traffic without changing the owner's normal mobile workflow, can distinguish human-business activity from customer inbound and Caye outbound, preserves that activity for durable reasoning with provenance, and cannot accidentally auto-reply to a human-authored echo.

Do not merge automatically.
