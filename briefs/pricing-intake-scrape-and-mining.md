# Session brief: pricing intake — website scrape + owner quote-mining

## Context

Caye is a WhatsApp-first AI receptionist for small tour/service businesses (see
`/Users/kwmlamar/Documents/TropiTech Solutions/Products/Caye/CLAUDE.md` and
`STATE.md` before doing anything — read both). Customers never see a
dashboard for business config; every anti-pattern in the parent CLAUDE.md
("settings pages for voice/tone/business info... configuration wizards")
applies here. Whatever this session builds must be doable entirely by
talking to Caye on WhatsApp.

Pricing is resolved deterministically via `service_pricing_tiers` rows +
`lib/services/resolve-tier.ts` — never LLM-paraphrased. That part is solid
and just got extended (2026-07-26) with a `variant` axis (e.g.
'standard'/'private') so a single group size can have two legitimate
prices, plus `source`/`confirmed_at` provenance columns. Read
`lib/services/resolve-tier.ts`, its test file, and
`supabase/migrations/20260726b_pricing_tier_variants.sql` to see the current
shape before designing anything — this session builds the INTAKE side, not
the resolution side.

## The problem

`lib/onboarding-whatsapp.ts` + `lib/onboarding.ts` run a WhatsApp discovery
grill (grill-me style: one question at a time, ≤10 questions, adaptive) for
brand-new cold-start signups. It ends by writing a single prose blob to
`workspace_ai_config.pricing_info` — it never creates a `booking_services`
row or any `service_pricing_tiers` rows.

Consequence: `resolveTier` gets an empty tier array for every brand-new
signup → `no_tiers_configured` → Caye holds every single price question
forever, silently, until the owner (or founder) manually adds tiers via
`add_pricing_tier`/SQL. This works today only because Bimini Island Tours
(the one paying customer) had its pricing hand-seeded via migration. The
next customer to sign up cold over WhatsApp gets nothing.

Real evidence this is a hard problem, not a simple one: read
`Clients/bimini-island-tours/pricing-audit.md` in full. It documents THREE
disagreeing sources for the same tours — the live catalog, Karenda's actual
sent email quotes, and (implicitly) whatever her website says. Whichever
intake method this session builds must not blindly trust any single source
as ground truth — that exact failure already burned a real customer
(Stallings incident, see `lib/services/resolve-tier.ts` header comment).

## What to build

Two independent capabilities. Scope and design each properly — don't treat
this as "add a scraper" and stop.

### 1. Website-scrape-to-draft during onboarding

When a new business gives a website URL (or one is inferable — ask for it
as part of discovery if not offered), fetch it and propose a draft catalog
(services + tiers) rather than writing anything live. Confirm **per
service**, conversationally, over WhatsApp — not one giant "here are 18
numbers, reply yes" blob (nobody will read that on a phone; see
`onboarding.ts` MAX_DISCOVERY_QUESTIONS reasoning for why short/adaptive
matters here too).

Design questions to resolve, don't guess past:
- Where does this step fit in the existing discovery flow
  (`decideNextDiscoveryStep` in `lib/onboarding.ts`)? Is it a fixed step
  after business name, or adaptive like everything else?
- What happens when there's no website (common for this ICP — many
  Caribbean operators are IG-only)? Must degrade to asking per-service
  without blocking completion of onboarding.
- What confidence signal does a scraped price carry into
  `service_pricing_tiers.source`/`confirmed_at`? (Should almost certainly
  be `source='website_import'`, `confirmed_at=null` until the owner
  explicitly confirms — see the migration comment for the enum meaning.)
- Multi-tier tours (private/shared variants, group bands) are common
  (Bimini has them on 2 of 6 tours already) — can a scrape even detect tier
  structure, or does it only reasonably extract a single base price per
  service, with tier-splitting left to a manual follow-up?

### 2. Owner quote-mining from their own sent messages

Karenda's Zoho inbox is already connected to Caye (OAuth, inbound sync
live — see `bimini-island-tours.md` pulse). The entire pricing-audit.md
document above was built by a human reading her `unified_messages` sent
quotes by hand. That's the higher-fidelity source (what she actually
charges beats what her website says) and it should be an ongoing background
check, not a one-time onboarding step — new discrepancies will keep
surfacing the way Sit-Low/Eat-Like-a-Local did.

Design as a **proactive suggestion**, matching the existing
observe-then-acknowledge pattern (see auto-memory:
`caye_behavior_lindy_pattern.md` if available, or just: Caye should notice
and propose, never silently overwrite). Rough shape: periodically (or
triggered off new sent messages) scan an owner's sent quotes for a
service/tier, compare to the current `service_pricing_tiers` row, and if
they disagree, message the owner: "I noticed you quoted $175 on Eat Like a
Local recently — my records say $190. Want me to update it?" — a yes routes
through the existing `update_service_price` tool.

Open questions this session must answer, not skip:
- This requires email channel access, which cold-start WhatsApp signups
  won't have yet — this is realistically a POST-onboarding capability for
  customers who later connect email, not part of the initial discovery
  grill. Confirm that scoping before building.
- What counts as a "quote" in a sent email is fuzzy (Karenda's emails mix
  price mentions with logistics, taxi fees, discounts). Needs a real
  extraction strategy, not a naive regex — and needs a clear bar for when
  to stay silent vs. surface a suggestion (a single one-off discount to a
  known contact should NOT trigger "should I lower this tier's price?").

## Constraints (do not violate)

- Never write scraped or mined prices directly into live
  `service_pricing_tiers` without an explicit owner confirmation — this is
  the exact class of error that caused the Stallings incident and the
  ongoing pricing-audit.md mess. Draft, propose, confirm, then write.
- No dashboard UI for any of this. If you find yourself designing a web
  form, stop — re-read the parent CLAUDE.md anti-patterns list and the
  Caye CLAUDE.md before continuing.
- Match the existing low-effort-per-message pattern: short questions, one
  at a time, confirm incrementally rather than batching.

## Where to start reading

1. `Products/Caye/CLAUDE.md` and `STATE.md` (product rules + state)
2. `Products/Caye/lib/onboarding.ts` + `lib/onboarding-whatsapp.ts` (current intake flow)
3. `Products/Caye/lib/services/resolve-tier.ts` + its test file (resolution model you're feeding)
4. `Products/Caye/supabase/migrations/20260726b_pricing_tier_variants.sql` (schema you're writing into)
5. `Clients/bimini-island-tours/pricing-audit.md` (why naive scraping/mining is dangerous)
6. `Products/Caye/lib/caye-agent/tools/write-low/add-pricing-tier.ts` (the tool a confirmed draft should eventually call)

Come back with a design (data flow, where the draft state lives before
confirmation, exact conversational scripts) before writing code — this
touches onboarding and live pricing for every future customer, worth
getting the shape right first.
