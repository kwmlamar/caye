# Brief — Verbatim block + "Get aligned with Caye" card

## Context

Caye's voice-learning loop today summarizes the owner's emails into a 6-field *description* (`writing_style`, `common_phrases`, `greeting_style`, `signoff_style`, `formality_level`, `tone_notes`) and feeds that into the reply system prompt. The summary works for tone but loses literal strings — Karenda's tagline `"Where Every Tour Tells a Story"` is paraphrased, not preserved. Karenda also has no visible signal that Caye is learning anything.

This brief adds a **verbatim block** (literal sign-off, tagline, opener stored as exact strings, appended without paraphrase) and a **dashboard "Get aligned with Caye" card** so the owner sees + confirms what Caye extracted.

Single profile, email-only for now. Per-channel profiles and multi-sender hardening are backlogged — do not build them here.

---

## 1. Schema delta

Add four fields to `customers.ai_voice_profile` JSON (existing column, just new keys inside it):

```ts
interface VoiceProfile {
  // existing
  writing_style: string
  common_phrases: string[]
  greeting_style: string
  signoff_style: string
  formality_level: 'casual' | 'warm-professional' | 'formal'
  tone_notes: string
  // NEW — verbatim block
  signature_block: string | null   // multi-line literal sig (business name + contact line if used)
  tagline: string | null            // literal tagline, e.g. "Where Every Tour Tells a Story"
  standard_signoff: string | null   // literal closing line, e.g. "Best regards," — kept separate from signature
  standard_opener: string | null    // literal opener used in >50% of samples, or null
}
```

No migration needed — `ai_voice_profile` is `jsonb`. Just update the TS type in [types/database.ts](types/database.ts) and [lib/voice-profile.ts](lib/voice-profile.ts).

Also add one new column:

```sql
ALTER TABLE customers ADD COLUMN voice_alignment_confirmed_at timestamptz;
```

Used by the dashboard card to mark "the owner has confirmed Caye's read of their voice." Card 3 hides once this is set.

---

## 2. Extractor change — [lib/voice-profile.ts](lib/voice-profile.ts)

Update `extractVoiceProfile()` to also extract the verbatim fields. New prompt:

```
Analyze these writing samples and extract the author's communication style AND any literal strings they reuse verbatim.

Return ONLY valid JSON — no markdown, no explanation:
{
  "writing_style": "2-3 sentences describing sentence length, formality, and structure",
  "common_phrases": ["phrases", "this", "person", "uses", "often"],
  "greeting_style": "how they typically open messages",
  "signoff_style": "how they typically close or sign off",
  "formality_level": "casual" | "warm-professional" | "formal",
  "tone_notes": "notable tone characteristics such as direct, empathetic, brief, enthusiastic",
  "signature_block": "EXACT multi-line signature as it appears at the bottom of their emails, or null if no consistent signature. Preserve line breaks with \\n. Do NOT paraphrase. Do NOT include greeting/signoff lines like 'Best regards' — only the identity block below them.",
  "tagline": "EXACT tagline string if one appears in 3+ samples, or null. Example: \"Where Every Tour Tells a Story\". Do NOT paraphrase.",
  "standard_signoff": "EXACT closing line used most frequently before the signature, e.g. \"Best regards,\" or \"Thanks,\" — or null if it varies",
  "standard_opener": "EXACT opening line if used in 50%+ of samples (e.g. \"Thank you for your interest in our tours.\"), or null if openers vary widely"
}

Rules:
- For verbatim fields (signature_block, tagline, standard_signoff, standard_opener): preserve case, punctuation, and line breaks exactly. If you would have to paraphrase to fit, return null.
- A field is "verbatim" only if it appears in 3+ samples with identical wording. One-offs go in null.
```

---

## 3. Reply injection — [lib/caye-reply.ts](lib/caye-reply.ts) `buildSystem()` around line 417

Currently the voice profile renders as a 6-line description. Add a verbatim block section that tells the model these strings are not to be paraphrased:

```ts
if (voiceProfile) {
  s +=
    '\n\nVOICE PROFILE — write in this person\'s actual style:\n' +
    `- Formality: ${voiceProfile.formality_level}\n` +
    `- Style: ${voiceProfile.writing_style}\n` +
    `- Common phrases to use naturally: ${(voiceProfile.common_phrases ?? []).join(', ')}\n` +
    `- Tone notes: ${voiceProfile.tone_notes}`

  // NEW — verbatim block. These strings must appear character-for-character.
  const verbatimLines: string[] = []
  if (voiceProfile.standard_opener) {
    verbatimLines.push(`- Opener (use verbatim when starting a new thread): "${voiceProfile.standard_opener}"`)
  }
  if (voiceProfile.standard_signoff) {
    verbatimLines.push(`- Sign-off line (use verbatim before the signature): "${voiceProfile.standard_signoff}"`)
  }
  if (voiceProfile.signature_block) {
    verbatimLines.push(`- Signature block (append verbatim, exactly as written, line breaks preserved):\n${voiceProfile.signature_block}`)
  }
  if (voiceProfile.tagline) {
    verbatimLines.push(`- Tagline (always include after the signature block): "${voiceProfile.tagline}"`)
  }

  if (verbatimLines.length > 0) {
    s +=
      '\n\nVERBATIM ELEMENTS — these strings must appear EXACTLY as written, never paraphrased, never reworded, never translated:\n' +
      verbatimLines.join('\n')
  }
}
```

Remove the `greeting_style` and `signoff_style` lines from the description block — they're now covered by the verbatim opener + signoff fields, and keeping both creates conflicting instructions.

---

## 4. New dashboard card — "Get aligned with Caye"

In [components/dashboard/SetupChecklist.tsx](components/dashboard/SetupChecklist.tsx):

**Replace the current 3 cards with:**

1. **Share your WhatsApp with Caye** — unchanged.
2. **Connect a channel** — collapse the existing "Connect Zoho Mail + Calendar" and "Connect WhatsApp Business" into one card. On click, show a picker: Zoho / Gmail (coming soon — disabled) / WhatsApp Business. Marks "done" when any one channel is connected.
3. **Get aligned with Caye** — NEW. Shown when `voice_alignment_confirmed_at` is null AND at least one channel is connected with 10+ owner-sent messages indexed. Clicking opens a modal.

**Card 3 modal behavior:**

1. On open, call new endpoint `POST /api/onboarding/voice-alignment/extract`:
   - Pulls the owner's last 30 sent emails (same query as `fetchOwnerMessageSamples` in [lib/owner-voice-learning.ts](lib/owner-voice-learning.ts)).
   - Runs `extractVoiceProfile()` (now with verbatim fields).
   - Returns the profile *without persisting yet*.
2. Modal shows extracted fields as editable text inputs:
   - **"How I think you write"** — 1-line summary derived from `writing_style` + `tone_notes` (e.g. *"Warm-professional, full sentences, signs off with a tagline."*). Read-only.
   - **"Your opener"** — `standard_opener`, editable, can be cleared.
   - **"Your sign-off line"** — `standard_signoff`, editable.
   - **"Your signature"** — `signature_block`, multi-line textarea.
   - **"Your tagline"** — `tagline`, single line.
3. Two buttons: **"This is me"** (saves and sets `voice_alignment_confirmed_at = now()`) and **"Skip for now"** (closes, can return later).
4. On confirm, call `POST /api/onboarding/voice-alignment/confirm` with the (possibly edited) profile. Endpoint writes to `customers.ai_voice_profile` and sets the timestamp.

**Copy for the card:**
- Title: **"Get aligned with Caye"**
- Sublabel: **"She read your last 30 emails — confirm how you sound"**

If `voice_alignment_confirmed_at` is set, show with a check + "Aligned" badge (matches the existing LIVE badge style).

---

## 5. New API routes

- `POST /api/onboarding/voice-alignment/extract` — runs extraction, returns profile, does not persist.
- `POST /api/onboarding/voice-alignment/confirm` — accepts edited profile, writes to `customers.ai_voice_profile`, sets `voice_alignment_confirmed_at`.

Both auth via existing workspace context.

---

## 6. Card 2 collapse — files to touch

In [components/dashboard/SetupChecklist.tsx](components/dashboard/SetupChecklist.tsx):
- Remove the separate `zoho` and `wa-business` channel items.
- Add a single `channel` item that opens a picker.
- Picker is a small dropdown or 2-button row: "Zoho Mail" / "WhatsApp Business." Gmail row present but disabled with "Coming soon."
- `done` = `zohoConnected || whatsappConnected`.
- Routes to the existing connect flows under the hood — no auth changes.

Keep the `ChannelTile` component; just change which tiles render.

---

## 7. What NOT to touch

- `TRUSTED_VOICE_CHANNELS` (still `['email']`) — per-channel profiles are backlog, not this PR.
- `maybeRefreshOwnerVoiceProfile()` counter logic — keep as-is, it will now also refresh the verbatim fields, which is fine for a single-profile setup.
- Multi-sender filtering — no `owner_email` check; Karenda is solo.
- The Settings → Caye AI panel — don't add a voice editor there yet. Backlog.
- The Caye chat — don't wire "show me how you think I write" yet. Backlog.
- Drift detection — backlog.
- The onboarding flow (`app/onboarding/`) — separate redesign, not this PR.
- Existing brand/styling on the dashboard — match the existing card look, don't restyle.

---

## 8. Files to touch

- [types/database.ts](types/database.ts) — extend `VoiceProfile` shape; add `voice_alignment_confirmed_at` to `customers`.
- [lib/voice-profile.ts](lib/voice-profile.ts) — update prompt, update return type.
- [lib/caye-reply.ts](lib/caye-reply.ts) — `buildSystem()` around line 417: add verbatim block injection, remove now-redundant greeting/signoff lines.
- [components/dashboard/SetupChecklist.tsx](components/dashboard/SetupChecklist.tsx) — collapse cards 2+3, add new card 3 + modal.
- `app/api/onboarding/voice-alignment/extract/route.ts` — NEW.
- `app/api/onboarding/voice-alignment/confirm/route.ts` — NEW.
- New migration: `supabase/migrations/20260609_voice_alignment.sql` — `ALTER TABLE customers ADD COLUMN voice_alignment_confirmed_at timestamptz;`

---

## 9. Acceptance

- Karenda opens the dashboard, sees a "Get aligned with Caye" card.
- Clicking it shows her tagline `"Where Every Tour Tells a Story"` and signature block, extracted from her sent mail.
- She taps "This is me." Card disappears.
- Next Caye-drafted reply to a customer ends with her exact tagline, character-for-character, not a paraphrase.
