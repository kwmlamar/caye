---
status: idea, not started
created: 2026-05-28
trigger: revisit after Caye-Front-Desk has 3-5 paying customers
---

# Caye — Multi-Employee Roadmap

The thinking from 2026-05-28 night, before sleep. Lamar floated extending Caye from a single AI receptionist into a roster of specialized AI employees, all WhatsApp-native, all able to talk to each other and to the owner. This file captures the frame so it survives until Caye v1 ships and we have room to think about it again.

## The reframe (the key move)

**Caye is not the receptionist. Caye is the BRAND for AI employees in your business.** Multiple specialized personas under one brand:

- **Caye — Front Desk** (current build — customer-facing receptionist, handles WhatsApp/IG/Messenger/email inquiries, takes bookings)
- **Caye — Operations** (next, eventually — internal-facing, handles ops work)
- Future possible: Caye — Bookkeeper, Caye — Sales, Caye — HR, Caye — Compliance, etc. (only as demand surfaces)

This is the Lindy structure (one brand, many specialized agents) — not the "Caye + a separate product" structure. Stronger positioning because every new employee strengthens the same brand instead of fragmenting attention across multiple SKUs.

## Why this architecture is right (pattern recognition)

Every modern AI platform has been converging on this: ChatGPT has Custom GPTs, Anthropic has Claude Projects, Lindy has user-created agents, OpenAI is building Agent Builder. The pattern emerges because:

- **Generic AI assistants are too vague** to be useful for specific jobs
- **Specialized AI for one job** is useful but lonely
- **A roster of specialized AI employees that collaborate** is the version that mirrors how real businesses work

The architectural insight is: agent-to-agent communication via shared state + an observable channel. Real coworkers in real offices talk to each other and the owner hears the parts that matter. AI coworkers can do the same: shared database for context, an "office chat" (WhatsApp group?) where they coordinate, and direct DMs to the owner when a decision is needed.

## What "Caye — Operations" might look like

Crisp version: an internal-facing AI employee accessible via WhatsApp, scoped to a single operational job (NOT "everything internal").

Concrete first-job candidates to consider (pick ONE for v1):

- **Caye — Scheduler:** handles project scheduling, sub-coordination, calendar conflicts for the day's work
- **Caye — Bookkeeper:** categorizes expenses, flags discrepancies, prepares for accountant handoff
- **Caye — Procurement:** manages vendor inquiries, tracks materials orders, watches for price changes
- **Caye — Project Manager:** tracks active jobs, escalates delays, coordinates with subs

For ODS (dad's company) specifically: probably **Scheduler** or **Project Manager**. Construction businesses bleed money on coordination friction. A specialized AI that watches the schedule + sub availability + materials delivery and surfaces conflicts before they bite would be high-leverage.

## The Caye ↔ Caye communication model (sketch)

Once there are two employees, they need to coordinate. Three possible mechanisms:

1. **Shared Supabase tables** — both AIs read/write the same workspace state (bookings, contacts, schedule). Simplest. Probably correct for v1.
2. **Direct message-passing** — Caye-Front-Desk explicitly @mentions Caye-Operations in a system channel: *"new booking Thursday 10am — anything I should know about subs that day?"* Operations replies. Conversation gets persisted.
3. **Observable group chat** — Owner + Caye-Front-Desk + Caye-Operations in one WhatsApp group. Owner sees the coordination happen. Can intervene. Strong demo moment.

Option 3 is the most compelling product moment but operationally complex (group chat dynamics, who speaks when, do they spam the owner). Option 1 is the foundation regardless. Probably build (1), layer (2) explicitly, defer (3) until the group-chat dynamics are figured out.

## What needs to be true before we start building this

Hard gates — don't start until all of these are met:

- [ ] **Caye-Front-Desk has 3-5 paying customers** (validation that the core product works on revenue)
- [ ] **Karenda's 30-day prove-value clock has resolved** (either she converts or she churns — both teach us, but we need the data)
- [ ] **A clear single-job description** for the next employee (not "operations" — specifically "scheduler" or "bookkeeper" or whatever)
- [ ] **The brother + TropiTrack overlap is resolved** (see open question below)
- [ ] **The ODS demo this weekend has revealed which operational pain matters most** (free product discovery)

## Open question — the brother + TropiTrack dynamic

Lamar's brother runs TropiTrack which is already an internal construction tool for ODS. Adding "Caye — Operations" risks:
- Stepping on TropiTrack's territory
- Creating product confusion for ODS (which tool do I use for what?)
- Family friction (brother could feel undercut)

Possible resolutions:
- **Caye — Operations integrates WITH TropiTrack** as the AI layer (TropiTrack remains the source of truth for construction project data; Caye sits on top and acts on it)
- **Brother and Lamar collaborate** on what becomes essentially "TropiTrack with Caye inside it" — joint product
- **Stay out of construction internal entirely** — Caye — Operations is built for a DIFFERENT vertical (Caribbean SMB ops) where the brother isn't competing

Lamar didn't answer this question in the conversation before sleep. Surface it again before any building starts.

## Use this weekend's ODS demo as discovery

When Lamar shows Caye to dad Sat/Sun, the real product gold isn't dad's reaction to Caye — it's **what dad asks for next.** Specifically:

- Watch for *"but can it also do [X]?"* — that's the operational job dad most wants done
- Watch for *"could it help me with [Y]?"* — same signal
- If dad mentions multiple operational tasks, note them all — that's the prioritization list for future employees
- If dad doesn't mention anything operational — interesting signal too. Maybe Caye-Front-Desk is enough for ODS, and "Caye — Operations" is a different customer entirely

Capture observations in [../../Clients/ods-construction.md](../../Clients/ods-construction.md) or create that file if it doesn't exist.

## Not in scope for v1 of multi-employee Caye

When eventually building, explicitly defer:
- User-created custom AI agents (the Lindy/Custom GPT pattern) — that's a platform feature, not a product feature. Comes way later if at all.
- A marketplace of employee templates
- Multi-business/multi-tenant employee sharing
- Specialized employees for verticals beyond what current customers actually need

## What to do next time we open this file

1. Confirm Caye-Front-Desk's customer count and resolution of Karenda's clock
2. Pick THE ONE operational job for the second employee
3. Resolve the brother + TropiTrack question
4. Sketch the shared-state architecture
5. Write a grilling-session-style brief like we did for WhatsApp messaging
