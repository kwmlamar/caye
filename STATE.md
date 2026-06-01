---
product: Caye
status: live — 1 pilot onboarded (Bimini), 2 in pipeline (Simply Dave blocked, ODS demo-ready)
last_updated: 2026-06-01
---

# Caye — Product State

Caye is TropiTech's AI receptionist for Caribbean SMBs. **Caye is the brand and the agent** — one name, two internal modes:

- **Front desk** — client-facing. Answers inbound (email now; WhatsApp/IG/Messenger wired), books customers, replies in the owner's voice, never reveals she's AI. Auth: public. *This is the wedge — every SMB has inbound.*
- **Back office** — crew/owner-facing ops assistant. Sees job files, costs, blockers, decisions queue. Knows she's AI. Auth: per-workspace phone allowlist. *This is the expansion — not built yet; ODS is the first customer who'll need it.*

Both modes live on one WhatsApp number per customer, routed by sender identity. Positioning: **"managed AI staff placed by a local operator,"** not a SaaS app. See [decisions-log 2026-05-10](../../_Ops/Brain/decisions-log.md), [2026-05-30](../../_Ops/Brain/decisions-log.md), [2026-05-31](../../_Ops/Brain/decisions-log.md).

## Pricing
- **$79/mo flat**, single tier. No founding discount. (decisions-log 2026-05-04)
- **$129/mo bundle** (Caye $79 + website hosting/maintenance $50) — Karenda only, since TropiTech built her site.
- Pilots get 2 free months on the paid plan + $20/mo referral kickback (stackable, capped at free).
- Unpaid-pilot slot **closed** after Bimini + Dave. All future customers pay from day one.

## Design principles (locked)
- **Agent, not app.** When Caye can work inside a tool the operator already uses (WhatsApp, Zoho/Google Calendar, Gmail) vs. building custom dashboard UI — choose the operator's tool. Dashboard = setup, settings, audit, conversation-with-Caye. NOT the daily surface. (decisions-log 2026-05-28, 2026-05-31)
- **Operator's tools are the canonical store.** Zoho Calendar is source of truth for Bimini's bookings; the internal `bookings` table is retired as canonical. Generalizes to Gmail/Google Calendar/Outlook. (decisions-log 2026-05-31, path 4A)
- **Conservative-and-visible over autonomous-and-embarrassing** — but with the 2B refinement: off-menu / upon-request inquiries get acknowledge + 1–2 qualifying questions + defer-to-owner (Caye never invents a price), flagged to the owner's queue. (decisions-log 2026-05-26, 2026-05-31)
- **Discovery-first onboarding** — Caye builds the owner's voice profile + service knowledge from their sent mail / pasted samples, so a customer with no system of record still gets value.

## Channels & integrations
- **Email (Zoho):** live. OAuth, inbound sync, per-tour-type templates, outbound send, auto-confirmation. **Inbox-only polling** (every other folder invisible; dragging a thread out of Inbox = owner's "stay out" lever). Newsletter pre-filter + identity guard shipped. (decisions-log 2026-05-26)
- **WhatsApp:** Cloud API on new **Caye WABA** (`1482716173600181`); legacy Tropichat WABA (On-Premise) left untouched. Inbound webhook built. Operator-side messaging (Caye → owner) is the v1 use. (decisions-log 2026-05-28)
- **Instagram + Messenger:** inbound webhooks built.
- **BSP / Embedded Signup:** TropiTech is a registered Meta Tech Provider — can onboard customers' WhatsApp without each one doing their own Meta setup. **Discovered, not yet built.** This is the fix for the #1 onboarding killer (see Broken/friction). (decisions-log 2026-05-28)
- **Payments:** no native processor. Use customer's existing rail — Bimini = WeTravel links stored per tour, included in confirmations; post-payment receipt → Caye matches → sends logistics. (Bimini pulse 2026-05-30)
- **Context Sources (external OS read):** designed, not built. Caye reads static knowledge (services, prices, job files) from a customer's Git repo / Google Drive / Notion. ODS `kwmlamar/ods-ai-os` is the test bed. Read-first, write-back later. (decisions-log 2026-05-30)

## Pilots
| Pilot | Vertical | Channel | Status |
|---|---|---|---|
| **Bimini Island Tours** | Tour operator | Zoho email | Onboarded 2026-06-01. Prove-value clock running (~2026-06-23). Only live path to first paid. |
| **Simply Dave Tours** | Tour operator | (blocked) | Blocked 3x on Facebook/Meta login; founder assessment "possible ghost." Kill-or-confirm pending. |
| **ODS Construction** | Construction | WhatsApp | Demo-ready. Needs ops layer (job data) before Caye-for-clients — construction = status questions, not booking questions. Gated on dad's voice-profile messages + demo. |

## Broken / friction
- **#1 — Meta/Facebook connection friction.** Killed the Dave onboarding entirely (3 failed reset attempts). Bimini's WhatsApp connect still pending for the same reason. **Highest-leverage fix: ship BSP Embedded Signup** so customers never touch a Facebook login.
- **Caye over-confident autonomy.** Replied to a mailing-list blast signed "Caye" (2026-05-26); held 3 real off-menu bookings requiring manual rescue (2026-05-31). Identity guard + newsletter filter + 2B defer mode shipped. Residual fix: **load the full pricing catalog** so Caye stops deferring items she should quote directly (`service_pricing_tiers` empty for Specialty Experiences).
- **Onboarding requires hand-holding.** Every pilot needed founder-driven setup. Embedded Signup + discovery-first onboarding reduce this; not yet self-serve.
- **Channel coverage is Zoho-only in practice.** Email pipeline proven end-to-end on Zoho; Gmail/Google Workspace not integrated; WhatsApp/Messenger/IG have inbound webhooks but no validated full flow. Selling to a Gmail-using prospect today means winning the demo and losing on onboarding. **This is the active gate on net-new conversion.**
- **Two sources of truth (legacy).** `bookings` table vs. Zoho Calendar — migration to Zoho-canonical (4A) designed, build deferred until Bimini converts.

## Open product threads (not yet built)

**Tier 1 — gates new customer onboarding (build before/with outreach scale):**
- **Gmail / Google Workspace integration** — inbound sync, outbound send, OAuth. Caye today is provably end-to-end only on Zoho; most Caribbean SMBs use Google. Decision already locked [2026-05-28](../../_Ops/Brain/decisions-log.md). Without this, any non-Zoho prospect can demo but can't onboard.
- **Channel flow validation (WhatsApp / Messenger / Instagram)** — webhooks are wired, but the full flow (inbound → AI reply → book → calendar event → confirmation) has only been proven on Zoho email. Each channel needs an end-to-end live test before being sold as ready. WhatsApp is highest-priority since it's the dominant Caribbean SMB channel.
- **"Catch-up welcome" onboarding feature** — on first connection, Caye scans the last ~5 days of mail/messages, summarizes what happened ("48 messages, 15 actual customer threads, 2 unread quote requests, here's what needs your attention") in the owner's voice. Mirrors Lindy.ai's onboarding moment. Demo amplifier — converts the abstract pitch into a concrete "she already knows my business" experience. Builds on existing discovery-first onboarding (decisions-log 2026-05-28). Bundle with Gmail since the read-mail surface is shared.
- **BSP Embedded Signup onboarding flow** — kills the Meta/Facebook login friction that broke Dave.

**Tier 2 — improves existing customers / unblocks expansion:**
- Full pricing catalog load (`service_pricing_tiers`)
- Back-office mode wired on WhatsApp (ODS allowlist)
- Context Sources read integration (GitHub → Caye)
- Zoho-canonical calendar migration (retire `bookings` table)
- WeTravel receipt → auto post-payment confirmation (Bimini)

**Build vs. sell:** Tier 1 ships in parallel with outreach, not before it. The demo motion (paste a real customer message, show Caye replying in their voice) doesn't require integration. Outreach builds the pipeline; Tier 1 lets the pipeline close.

## Domains
`meetcaye.com` (primary), `getcaye.com` (defensive), `tropichat.chat` (platform layer). Skipped `.ai` (squatter on `caye.ai`).

## Reference docs in this repo
[BACKLOG.md](BACKLOG.md) · [whatsapp-build-state.md](whatsapp-build-state.md) · [multi-employee-roadmap.md](multi-employee-roadmap.md) · [db-refactor-plan.md](db-refactor-plan.md) · [domain-migration-checklist.md](domain-migration-checklist.md) · [PERSONA.md](PERSONA.md)
