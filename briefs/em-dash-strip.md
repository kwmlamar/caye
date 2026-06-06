# Brief: Strip em-dashes and en-dashes from Caye's outbound messages

## Why
LLMs leak em-dashes (`—`) and en-dashes (`–`) into replies even when the system prompt forbids them. Lamar wants Caye's messages to read like a real person, not a chatbot. Prompt-level rules (added 2026-06-05 to both workspace_ai_configs) reduce the rate but do not eliminate them. We want zero dashes shipping to customers.

## Scope
Add a single post-process sanitization step that runs on every outbound message body **after the LLM has generated it** and **before it is persisted to `unified_messages` and dispatched to the channel adapter**. Applies to all channels: email, WhatsApp, Instagram, Messenger.

Out of scope: inbound messages, internal Caye thread messages (`caye_messages`), human-authored messages (operator typing into the inbox manually). Only Caye-generated `sender_type='business'` outbound messages.

## Where
Find the function that takes the LLM response string and writes it to `unified_messages` / hands it to the channel sender. Likely candidates in this repo:
- `Products/Caye/backend/` — look for an outbound dispatch / send-message function
- Anything calling the OpenAI / Anthropic completion API where the response is then forwarded

Single point of insertion. Do not sprinkle the regex across channel adapters.

## Transformation rules

Apply in this order:

1. `\s*—\s*` → `. ` then capitalize next letter if the prior char was sentence-ending. (Em-dash between clauses becomes a sentence break.)
2. `\s*–\s*` → `, ` (En-dash between phrases becomes a comma.)
3. `—` → `-` (bare em-dash with no surrounding spaces, e.g. inside a word, falls back to hyphen)
4. `–` → `-` (same for en-dash)

After substitution, collapse any `..` → `.` and ` ,` → `,` to clean residue.

## Edge cases

- Numeric ranges: `9–11` should become `9-11`, not `9, 11`. Rule 2 only fires when the en-dash is surrounded by spaces, so this is handled by falling through to rule 4.
- Already-clean messages: regex is idempotent; running on a dash-free string is a no-op.
- Emoji / Unicode: do not touch any other Unicode. Only the two specific code points U+2014 and U+2013.

## Tests to add

- "Great choice — the 2-Hour tour is wonderful." → "Great choice. The 2-Hour tour is wonderful."
- "Adult $190 · Child $150 — group rate" → "Adult $190 · Child $150. Group rate"
- "9–11 AM" → "9-11 AM"
- "Hours: 9 – 11 AM" → "Hours: 9, 11 AM" (acceptable, en-dash between spaces is rare)
- "no-dash message" → unchanged

## Acceptance

- All four channel send paths route through the sanitizer (verify by grep for direct LLM-response-to-adapter calls — there should be none after this change).
- Unit tests cover the table above.
- Manual smoke: send a test message through Caye that the LLM is likely to put an em-dash in (e.g. a quote acknowledgement) and verify no em-dash in the persisted `unified_messages.content`.

## Notes

- Do not modify the LLM prompt as part of this work — the prompt rule was added separately in `workspace_ai_config.system_prompt` for both the TropiTech and Bimini workspaces on 2026-06-05. The post-process is belt-and-suspenders.
- The post-process is the bulletproof layer. If a future model leaks dashes despite the prompt, this still catches them.
