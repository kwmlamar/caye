---
doc: Caye outreach script
status: v2 — rewritten for front-desk/back-office agent positioning
supersedes: the omnichannel-inbox pitch (Apr 2026)
last_updated: 2026-06-01
pairs_with: ICP.md
---

# Caye — Outreach Script (v2)

**Why this exists:** the v1 cold outreach (~a month ago) sold an *omnichannel inbox* — a tool the owner logs into to handle messages. Caye is now the opposite: **an AI receptionist that handles the messages for them, in their voice, so they're not in the inbox at all.** Selling the old tool to the new product loses the room. This is the rewrite.

## Core positioning (say this, not "omnichannel inbox")
> **"Caye is a receptionist who answers your messages and books your customers for you — 24/7, in your own voice — so you're not glued to your phone."**

Sell the **outcome** (you stop missing bookings; you get your evenings/Fridays/Sundays back), not the tech. Lead with their pain, not Caye's features.

## What NOT to say
- ❌ "omnichannel inbox" / "unified inbox" / "manage all your messages in one place" — that's the old tool and it puts *them* back to work.
- ❌ "AI chatbot" / "automation platform" — sounds like a robot they have to configure.
- ❌ A feature list (channels, webhooks, dashboard). Nobody buys features; they buy time and lost-booking recovery.
- ❌ Don't open by saying it's AI. Lead with the outcome; the "how" comes after they're interested.

---

## 1. Cold email opener (2026-07-29 — problem-first, job-description positioning; fourth and current revision of the live A/B test)
Personalize exactly ONE sentence (the hook — name the business, state a confident un-hedged truth about their situation, never "probably"). Everything after it is the SAME wording across a whole batch, on purpose: self-id ("I'm Lamar, founder of TropiTech, a Bahamian tech company. I built Caye."), then what Caye's JOB is — never a bare label ("assistant"/"AI employee"/"chatbot"/"receptionist" are categories, not jobs, and never say "AI"/"automation"/"LLM" at all) — kept short and visual, working in that she lives inside WhatsApp itself, then proof ("working alongside another Bahamian business" unless the lead is actually a tour operator), then a short conversational CTA ("Want to see it in action?", not the flatter "Interested?"). Write at an 8th-grade reading level — cut any word that doesn't change the meaning. Target 50-70 words, hard cap 90 — word count, not sentence count. Supersedes the earlier "direct-pitch" and "pain-point-question" openers below (both kept for reference / the WhatsApp-DM channel).

> While you're busy running [Business], WhatsApp messages keep coming in. I'm Lamar, founder of TropiTech, a Bahamian tech company. I built Caye. She lives in WhatsApp, making sure every customer gets a reply before they give up and move on. She's already working alongside another Bahamian business every day. Want to see it in action?

*This is the tool `create_outreach_leads` (lib/caye-agent/tools/write-low/create-outreach-leads.ts) actually follows as of 2026-07-29 — keep that file and this section in sync if either changes.*

## 1a. Direct-pitch opener (2026-07-29, first revision — superseded by section 1 above same day)
Self-intro first, always, then situation/what Caye does/proof/ask, one sentence each, 3-4 sentences max. Superseded because it still spent too much of the email proving research instead of naming the reader's problem.

> Hey [name], I'm Lamar with TropiTech, a Bahamian tech company. I built something called Caye — she answers your WhatsApp messages and books customers for you, even when you're busy. One tour operator in the Bahamas is already using her. Want to try it free?

## 1b. Pain-point opener (pre-2026-07-29 default — parked pending the A/B result; still the live approach for WhatsApp / IG DM, keep it short, voice-note friendly)
> Hey [name] — I run TropiTech, a Bahamian tech company. I saw [specific: your tours / your reservations are "DM to book"]. Quick question: who handles all your messages when you're [on the boat / in the kitchen / with a client]?

*Goal: start a conversation, surface the bottleneck. Don't pitch yet. Let them tell you the pain.*

If they engage:
> That's the thing most [tour operators / restaurants] tell me — messages pile up and a booking slips through. I build a receptionist called Caye that answers those messages and books people for you automatically, in your own voice, even when you're busy. Want me to show you what she'd sound like answering one of your real customer messages?

*The demo offer is the close, not a meeting. Show, don't tell — same thing that worked on Karenda and is planned for ODS.*

## 2. Warm referral intro (the strongest channel — use it first)
When a pilot or contact refers you, the credibility is theirs, so stay light:
> Hi [name] — [Karenda / referrer] mentioned you might be drowning in customer messages like she was. I built her an AI receptionist (Caye) that handles her booking replies for her now. Happy to show you the same thing on one of your real messages — takes 10 minutes, no commitment.

## 3. The qualifying questions (work these in early — from ICP.md)
1. Who answers your messages today, and how fast?
2. Ever lost a booking because a message got missed?
3. Do your services and prices stay mostly the same week to week?
4. Can you log into your own Facebook / WhatsApp Business right now?

*#2 gives you their pain in their own words — reuse it. #3 and #4 tell you if they're a real front-desk fit or a stall risk before you sink time in.*

## 4. The demo (this is the actual sales motion)
Caribbean SMBs buy from a trusted local showing receipts, not from a pitch (decisions-log 2026-05-10). Two ways to run it — lead with the self-serve one, it removes the "find 10 minutes with Lamar" friction entirely:

**Self-serve demo (default — give them this link, don't gatekeep it behind a call):**
> Head to https://www.meetcaye.com and hit "Try for Free." It'll text you from Caye's real WhatsApp number and ask a few quick questions about your business — no card, no signup form. Takes about 5 minutes and you'll see exactly how she'd sound handling your customers.
Always frame it as concrete mechanics (the link, "texts you from her WhatsApp," "no card/no signup," "~5 minutes") — not a vague "I'd love to show you what that looks like." The concreteness is what gets the click.

**Founder-led demo (fallback for a warm/engaged lead who wants Lamar walking them through it live):**
- Take **one of their real, recent customer messages** (not an invented one).
- Show Caye replying to it **in their voice**.
- If they lean in → onboard right there. If they don't → the voice profile or the example missed; fix and retry.

## 5. Follow-up (after silence — once, then stop)
> No rush [name] — whenever you've got 5 min, head to https://www.meetcaye.com and hit "Try for Free." She'll text you straight from WhatsApp and walk you through it herself — no card, no call needed.
Restate the self-serve link/mechanism, not a generic "I'd love to show you" — the follow-up's whole job is to make the next step as frictionless as the first message implied it would be.

*One follow-up. If they go silent like Dave did, mark the lead cold and move on — chasing ghosts is wasted outreach.*

---

## Objection handling
- **"Is it a robot? My customers will know."** → "No — she replies in your voice, your words, your tone. Your customers just experience faster, consistent answers. She never says she's AI." (This is enforced in the product — identity guard.)
- **"I already answer my own messages."** → "You do — and you do it well. The problem is the ones that come in while you're [on a tour / closed / on your day off]. Caye catches those. How many do you think slip through in a week?"
- **"How much?"** → "$79 a month. One booking you'd have lost pays for it almost two months over. It's built for Caribbean businesses, not US prices."
- **"I'm not techy."** → "You don't touch anything. I set Caye up for you and she works inside the tools you already use — your email, your WhatsApp. You don't log into a dashboard to run your day."

## Pricing to quote
$79/mo flat. Bundle ($129/mo, +website hosting) only for customers whose site TropiTech also builds. No founding discount; no free pilots (slot closed after Bimini + Dave). See [STATE.md](STATE.md) and [decisions-log 2026-05-04](../../_Ops/Brain/decisions-log.md).

## Targeting reminder
Pull names from [ICP.md](ICP.md): Bahamas-first, owner-operated, stable-catalog businesses (tours, restaurants, salons, guesthouses, clinics, rentals) whose owner is drowning in DMs. **Not** construction/project-based (back-office play, longer cycle). **Not** US-mainland. Warm-by-referral beats cold every time.
