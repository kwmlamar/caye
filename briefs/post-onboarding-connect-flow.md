# Post-onboarding channel connection flow

**Date:** 2026-08-06
**Status:** Designed, not built. 12 decisions locked via grill session.
**Supersedes:** the current wrap-up message in `lib/onboarding-whatsapp.ts:406-414` and the `/connect` six-card grid.

---

## Why

Discovery already works. Channel connection is where customers are lost, and nothing in
the product notices.

Production data (queried 2026-08-06):

| Workspace | Signed up | Channels connected | Outcome |
|---|---|---|---|
| Bimini Island Tours | 2026-04-15 | IG + Messenger **same day**, email 2026-05-14, WhatsApp never | Active, paying |
| Simply Dave Nassau Tours | 2026-04-29 | **none, ever** | `status: inactive` |

Your retained customer connected two channels on day one. Your churned customer connected
zero. Nobody was alerted to either. Bimini's WhatsApp connection has been open for ~4
months; it was discovered by grepping a hand-maintained markdown file, which was itself
stale (it doesn't record the 2026-05-14 email connection).

Note the check on this whole redesign: **the existing six-card grid produced same-day
activation for the one paying customer.** The failure mode is not the grid. It's that
nothing catches the people who never touch it.

---

## Locked decisions

**1. Chat does the thinking, the browser does the clicking.**
Caye orchestrates in WhatsApp; OAuth happens in a browser. Not a web wizard, not a
pure-chat flow.

**2. Naked deep links per channel, with callback-driven progression.**
`/api/auth/gmail?...` is already a bare redirect to Google — textable today. The OAuth
callback fires Caye's next WhatsApp message the moment the row upserts, so the user closes
the tab and the next step is already waiting. Add `source=wa` to the existing `state` param
(`app/api/auth/gmail/route.ts:37`) landing on a thin "connected — head back to Caye" page.

**Exception: WhatsApp Business cannot be a link.** Embedded Signup is the Facebook JS SDK
calling `FB.login` with a `config_id` in a popup (`ChannelsPanel.tsx:203-310`). It requires
a real page. This asymmetry is invisible to the user — they experience "tap, come back,
tap, come back" either way.

**3. Detect email, ask only about social.**
The email captured in discovery question two (`onboarding-whatsapp.ts:300-310`) gives the
domain. An MX lookup resolves Google vs Zoho vs Microsoft without asking. Caye opens with
*"Looks like your email runs through Google — want me watching that inbox?"* rather than
"what tools do you use?"

Only Instagram / Facebook / WhatsApp Business need asking, as a single yes/no question.

Tools named that Caye can't connect (Outlook, Square, Calendly) get an honest
acknowledgement and **get stored**. Cheapest connector-roadmap signal available.

**4. Connection is the last step of onboarding, not an optional epilogue.**
Today Caye says "I'm live 🎉" while watching nothing, then hands over a chore, plus a
competing `/login` link, plus a demo offer. Replace with a handoff. **The celebration moves
to the first successful callback** — the first moment "I'm live" is true.

- Cut the `/login` link from that message (billing can wait; a second CTA halves the first).
- Cut *"Nothing here is required"* from `/connect` (`ConnectClient.tsx:50`).
- Keep this outside the adaptive discovery question budget.

**5. Gmail first, WhatsApp second.**
A completed connection changes their relationship to the flow. Caye drives to WhatsApp from
"I'm already working," not "I need one more thing." This reverses an earlier
WhatsApp-first call.

**6. Derive walkthrough state — don't store it.**
No state machine, no new columns. Three facts: what they said they use (inventory), what's
connected (`connected_accounts` where `is_active`), what's next (first unconnected slot in
priority order). Recomputed on demand.

Survives the nine-day disappearance with no resume logic and no stale pointers.

Two new tools in `lib/caye-agent/tools/registry.ts` (currently has **no** channel tools):
- `get_channel_status` (read)
- `send_connect_link` (write-low)

Sequence stays in code — callbacks drive progression, the agent only handles replies.

**7. Signed, expiring links.**
All three OAuth entry points take a raw `workspaceId` with zero auth
(`gmail:19`, `zoho:7`, `meta:10`). That was tolerable when only a logged-in dashboard
produced those URLs. Texting them puts standing inbox access into a forwardable medium.

Swap to `?t=<hmac payload {workspaceId, channel, exp}>`, 7-day TTL, one shared helper.
Expiry is free because `send_connect_link` re-mints on request.

Realistic risk isn't an attacker — it's the owner forwarding "here, you do it" and the
wrong mailbox getting attached.

**8. Zero channels → alert the founder. Some channels → evidence-based nudge only.**

- **Zero after ~48h:** Lamar gets pinged, handles it personally. This is the Simply Dave
  case and it is a churn emergency, not a nudge opportunity. Reuse the
  `notifyFounderOfNewSignup` shape (`onboarding-whatsapp.ts:204`).
- **Some connected, others missing:** wait until Caye has caught something real, then
  *"Caught a booking question on email this morning. If your Instagram DMs came to me too,
  I'd catch those the same way."* Proof, not nagging. Only possible because Gmail-first
  gets her real data early.

**Hard cap: one evidence nudge per channel, ever.** No sequences. Week-one trust is worth
more than an Instagram connection, and a nag sequence teaches them to ignore every
important message she sends later.

The existing `app/api/caye/nudge-scan/route.ts` is guest-facing only — this is new
behaviour, though it can ride the same cron.

**9. Gate WhatsApp behind a qualifying question.**
Connecting a number to the Cloud API **migrates** it — the WhatsApp app stops working on
that number. For an owner whose business phone is their phone, that's a non-starter.

**Confirmed 2026-08-06: this is exactly why Bimini stalled.** Karenda runs the business off
her personal phone. Her WhatsApp was never going to connect, and no amount of UX work would
have changed that. Four months of an "open task" that was actually a correct decision
nobody had made out loud.

Before the WhatsApp step, always:
> *Is the number guests WhatsApp you on a separate business line, or the same phone you use yourself?*

- **Separate line** → send the link.
- **Same phone** → **do not send the link.** Explain the tradeoff, suppress the Q8 nudge
  for WhatsApp permanently, flag Lamar.

**"WhatsApp never connects" is a valid, non-failing end state.** The flow must be able to
finish on email + IG and mean it.

**Say this explicitly when gating:** declining WhatsApp front-desk does *not* mean losing
Caye on WhatsApp — they still talk to her on the back-office number. Without that sentence,
"no WhatsApp" reads as "no Caye" and someone churns over a misunderstanding.

**10. Don't recommend a new business number. Offer it, conditionally.**
A new number has no traffic — the old one is on the Google listing, IG bio, flyers,
TripAdvisor, and every past guest's phone. Connecting Caye to a fresh line means she
answers a phone that never rings, which destroys the Q8 evidence strategy.

Only worth it if they'll actually republish it everywhere. Caye ties the offer to that
condition and lets them self-select. Most won't — correct outcome.

**Bimini: recommend against.** Bookings come through her website; WhatsApp is nice-to-have.
Not worth republishing her number across every listing.

**11. Qualify before destructive steps; recover after cheap ones.**
WhatsApp gets a gate (migration is irreversible). Instagram, Gmail, Zoho, Messenger get
good failure recovery instead — most owners genuinely can't answer *"is your IG a
professional account linked to a Facebook Page?"*, so asking produces wrong answers.

Route Meta's failure reasons into Caye saying something useful (*"Looks like your Instagram
isn't linked to a Facebook Page yet — two minutes in the app, want me to walk you
through it?"*) instead of the current `instagram_error=…` toast
(`ChannelsPanel.tsx:135-138`) that a WhatsApp-first customer will never see.

**12. `/connect` becomes a single-channel executor.**
`?ws=X&only=whatsapp` — one card, one button. Everything else is a deep link now, so the
menu's only remaining job is Embedded Signup. A six-card menu re-introduces the choice the
chat flow exists to remove, and invites wandering into the Q11 Instagram wall.

The grid keeps its home in **dashboard settings** — a genuinely different job (management,
months later) deserving a different surface. Mechanically this is the existing
`variant === 'onboarding'` branch (`ChannelsPanel.tsx:350`).

Kill **"Go to dashboard →"** (`ConnectClient.tsx:44-49`) — mid-walkthrough the correct next
step is back to WhatsApp, not into a dashboard.

**13. Instrument only what can't be derived.**
Derivable today from `connected_accounts.created_at` vs `customers.created_at`:
- % of signups with ≥1 channel within 48h (activation)
- median time to first connection (friction)

Log only three things: `link_sent`, `oauth_failed` (with reason), `gated` (with reason).
No dashboard — Lamar asks back-office Caye *"who's stuck?"*, answered via
`get_channel_status`. Earns a founder-rail card later if it proves useful.

**14. Roll out with no backfill.**
- **Collapse channel types into logical slots.** Bimini's row is `channel_type: 'email'`;
  the Gmail callback writes `'gmail'` (`gmail/callback:79`). Naive derivation would ask a
  paying, fully-activated customer to connect an inbox that's worked for months. Ship-blocking.
- **No tool inventory → no walkthrough.** Every existing workspace predates the inventory
  record, so all are silently grandfathered. Zero migration, zero risk of a 6am message to
  Karenda about a channel she deliberately skipped.
- **Test via cold start.** `tryColdStartWorkspace` (`onboarding-whatsapp.ts:144`) means any
  unrecognised number gets a clean workspace. Borrow a phone, run it end to end, delete.

---

## Must verify before building

1. ~~Does Google OAuth survive WhatsApp's in-app browser?~~ **Resolved 2026-08-06 by
   detection instead of testing.** No Android device was available, and the question doesn't
   need answering: the OAuth initiators now read the request User-Agent
   (`lib/channels/embedded-browser.ts`) and divert only embedded browsers to
   `/connect/open`, an interstitial that escapes to the real browser via an Android
   `intent://` URL. Real browsers redirect straight through and never see it, so there is no
   extra tap for anyone who doesn't need one, and no dead end for anyone who does. Detection
   errs toward false positives on purpose — a needless interstitial costs one tap; a missed
   webview costs the activation.

   Verified end-to-end against a local server with spoofed User-Agents, all three providers:
   desktop UA → straight to the provider; Android WebView UA → interstitial; interstitial's
   `ext=1` link → straight to the provider (no loop); bad token → `/connect?link_error=…`;
   a Zoho token replayed on the Gmail route → `channel_mismatch`.

2. ~~Ask Karenda the Question 9 question.~~ **Resolved 2026-08-06 — she uses her personal
   phone.** See decision 9. Follow-on actions:
   - Tell Karenda it's fine to skip WhatsApp, and that she still has Caye on WhatsApp via
     the back-office number. Closes the loop.
   - Correct `Clients/bimini-island-tours.md` — "WhatsApp pending setup" (lines 64/137) is
     wrong. It's **gated by constraint, not outstanding.** It has been generating false
     guilt on the task list for four months. The same file also never recorded the
     2026-05-14 email connection.
   - **Base rate: measured 2026-08-06, inconclusive.** Twilio Lookup across all 217 leads
     with phone numbers ($1.05) returned 67% mobile overall — but Bahamas (74 mobile / 0
     landline) and Barbados (43/0) are not credible readings, and they carry the average.
     Trinidad (25% mobile) and Jamaica (48%) look trustworthy and sit below the threshold.
     **Only asking prospects directly can settle this** — append the question to the
     existing disqualifier check in `_Ops/Outreach/CLAUDE.md`. Positioning was amended
     anyway (see decisions-log 2026-08-06); the new framing holds under either result.
   - **Note for channel design:** a landline *can* be registered to WhatsApp Cloud API by
     voice verification, and nothing is lost because nobody runs the app on a landline.
     Landline-listing businesses are safely connectable — the gate in decision 9 only needs
     to fire for mobile numbers.

3. **Pick the activation threshold before shipping**, not after. Proposal: *≥1 channel
   within 48h for 60%+ of signups.* Decide now or you'll rationalise whatever number
   arrives. With 1-3 customers this is anecdote, not statistics — treat it as such.

---

## Files in scope

| File | Change |
|---|---|
| `lib/onboarding-whatsapp.ts:406-414` | Rewrite wrap-up: handoff not celebration, one CTA |
| `app/api/auth/{gmail,zoho,meta}/route.ts` | Signed-token auth; `source=wa` |
| `app/api/auth/*/callback/route.ts` | Fire Caye's next message; `wa` landing page; failure reasons |
| `lib/caye-agent/tools/registry.ts` | `get_channel_status`, `send_connect_link` |
| `components/settings/ChannelsPanel.tsx:350` | `onboarding` variant → single-channel renderer |
| `app/connect/ConnectClient.tsx` | Drop dashboard CTA + "nothing required"; accept `only=` |
| new | MX lookup; inventory storage; unsupported-tool log; funnel events; zero-channel alert |
