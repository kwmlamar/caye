# Sanitized WhatsApp coexistence fixtures

Hand-built from Meta's published payload schemas (the "Onboard WhatsApp
Business app users" guide and the `smb_message_echoes` webhook reference,
checked 2026-09-02). No production capture, no real phone numbers, no real
message ids, no tokens or signatures.

Conventions used throughout:

- `15550000001` — the business's own WhatsApp number (reserved test range)
- `15550000042` — an external customer
- `wamid.TEST_*` — obviously synthetic Meta message ids
- `000000000000000` — placeholder WABA id / phone_number_id

`history.json` and `smb-app-state-sync.json` exist to pin the "recognised but
deliberately not ingested" behaviour, not because this milestone parses them.
Bounded history import is a separate slice — see
`briefs/whatsapp-coexistence-ingestion.md` §5.
