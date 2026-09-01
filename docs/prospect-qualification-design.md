# Caye Prospect Qualification System — Design & Spec

**Status:** Design phase — ready for implementation  
**Date:** 2026-08-31  
**Mission:** Make Caye continuously find businesses that are genuinely likely to buy Caye. Optimize for *qualified prospects → positive replies → customers*, not volume.

---

## 1. Current State Audit

### Existing Infrastructure
- **outreach_leads table** — tracks email, send state, opt-out, demo-token signal
- **outreach_sourcing_targets table** — fixed vertical×region list (Bahamas-primary + Jamaica/Trinidad/Barbados)
- **Outreach tracker (markdown)** — ~461 manual log entries since 2026-06-01, tracking business/type/island/channel/response
- **Lead source (Excel)** — 271 Caribbean leads, manually sourced from business registries + index sites

### What's Missing
- **Prospect-level qualification score** — no explainable composite signal; no way to prioritize follow-ups
- **Evidence-based signals** — observed pain, likely fit, disqualifiers not stored; impossible to correlate with reply rates
- **Contact channels** — only email tracked; WhatsApp/IG/phone unknown
- **Source tracking** — how each lead was found (Places API, registry, referral, etc.) not recorded
- **Pain classification** — no standard taxonomy of observed pain vs. assumed pain
- **Follow-up pipeline state** — nudge_count exists but no structured tracking of which 3 touches sent, when next one due
- **Qualification audit trail** — impossible to replay why someone was qualified/disqualified

### Actual vs. Expected Patterns (first 461 sends)
| Metric | Current | Ideal |
|--------|---------|-------|
| Response rate | ~10% (44 responses logged) | N/A — measure against baseline after qualification |
| Demos booked | ~3 (Davia Smith warm, Shore 2 Shore cold, Zanzibar soft) | Correlate: high-qual leads → demo rate |
| Closed | 0 (Bimini was pilot) | Target: 1 per 50 qualified sends at v1 |
| Lead quality variance | Unknown — no scoring | Measure after tier 1 impl |
| Disqualification rate | Manual/after-the-fact | Track pre-send and measure accuracy |

---

## 2. Qualification Framework (from ICP.md + decisions-log)

### Proven Fit Signals (Bahamas tour ops)
- Inbound scattered across multiple channels (email, IG, WhatsApp, Messenger)
- Owner/handler is the bottleneck — personally drowning in DMs
- Services and prices stable week-to-week (catalog-stable)
- Visible lost opportunity ("missed a booking because of delayed response")
- Able to access own Meta/email accounts (onboarding friction gate)

### Evidence-Based Pain Categories
1. **Confirmed observed** (valid, specific)
   - "Instagram comments asking for availability without responses"
   - "Replies pile up overnight while owner is on the boat"
   - Live social media presence with visible slow/inconsistent replies

2. **Assumed/generic** (invalid, do not use)
   - "Owner loses $4,000/month from missed WhatsApps" — fabricated
   - "They're clearly overwhelmed" — reading from a distance

### Disqualifiers
- Cannot access own Facebook/Meta (onboarding blocker, like Dave)
- Project/status-based business needing back-office layer first (construction, custom work)
- No demonstrated inbound volume (not drowning in messages = no pain)
- Price-shopper mentality or wants to own the code
- Cannot reach through trust (non-Caribbean; no local connector) — colder, not impossible

### Multi-Channel Fit Assessment
| Channel | Viability | Notes |
|---------|-----------|-------|
| Email | Always | Baseline channel, proof point on Zoho integration |
| WhatsApp (guest) | If separate business line | Requires personal phone constraint check; if yes, don't promise it |
| Instagram/Messenger | Available | Webhooks live; validation pending |
| Phone/WhatsApp (personal) | Never for guest-facing | Owner can't give up personal number; available for back-office only |

---

## 3. Database Schema Extensions

### New Table: `prospect_qualifications`
Purpose: Capture structured qualification data per prospect, audit-trailable, scored.

```sql
create table public.prospect_qualifications (
  id uuid primary key default gen_random_uuid(),
  
  -- Reference
  outreach_lead_id uuid not null unique references public.outreach_leads(id) on delete cascade,
  workspace_id uuid not null references public.customers(id) on delete cascade,
  
  -- Prospect identity & context
  business_vertical text not null,           -- tour operator, restaurant, salon, etc.
  business_region text not null,              -- Nassau Bahamas, Kingston Jamaica, etc.
  contact_channels jsonb not null default '{}'::jsonb, -- {email, phone, whatsapp, instagram, facebook}
  source text not null,                        -- places_api, registry, referral, manual, etc.
  
  -- Qualification signals (observed facts, not assumptions)
  inbound_channels_observed text[],            -- channels they're actually reachable on
  visible_response_slowness boolean,           -- observed social/web evidence of slow replies
  volume_signal text,                          -- 'high' / 'medium' / 'low' / 'unknown'
  catalog_stability_observed text,             -- 'stable' / 'custom_per_job' / 'unknown'
  meta_access_verified boolean,                -- Can owner access own Facebook/Meta
  personal_phone_constraint_checked boolean,   -- Asked Q#5 from ICP.md
  personal_phone_constraint boolean,           -- True if uses personal phone for biz
  
  -- Evidence trail (observed, not assumed)
  pain_observations text[],                    -- array of specific observed signals
  disqualifier_flags text[],                   -- e.g., ["cannot_access_meta", "project_based"]
  likely_pain_category text,                   -- "messages_pile_up" / "slow_response" / "booking_loss"
  why_caye_fits text,                          -- Specific explanation for this prospect
  
  -- Scoring
  qualification_score integer default 0,       -- 0-100, computed from signals below
  score_breakdown jsonb default '{}'::jsonb,  -- {signal_name: points, ...} for explainability
  
  -- ICP fit assessment
  icp_fit_level text not null default 'unknown', -- 'strong' / 'moderate' / 'weak' / 'disqualified'
  icp_fit_notes text,                          -- Why this fit level
  
  -- Temporal
  qualified_at timestamptz,                    -- When this prospect entered the qualified pool
  disqualified_at timestamptz,                 -- If disqualified, when and why (stored in disqualifier_flags)
  last_assessed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  
  constraint qualification_timeline check (
    (qualified_at is null or disqualified_at is null) or
    (disqualified_at > qualified_at)
  )
);

create index idx_prospect_qualifications_workspace on prospect_qualifications(workspace_id);
create index idx_prospect_qualifications_icp_fit on prospect_qualifications(icp_fit_level, created_at);
create index idx_prospect_qualifications_score on prospect_qualifications(qualification_score desc);
```

### Extended: `outreach_leads` Columns
Add to existing table to link qualification:

```sql
alter table public.outreach_leads
  add column if not exists vertical text,           -- tour operator, restaurant, etc.
  add column if not exists region text,             -- Nassau Bahamas, etc.
  add column if not exists contact_phone text,      -- Phone if available
  add column if not exists contact_whatsapp text,   -- WhatsApp if different from phone
  add column if not exists source text,             -- places_api, registry, referral, manual
  add column if not exists stage text not null default 'sourced';  -- sourced → drafted → sent → (replied/tried/converted)
```

### New Table: `prospect_outreach_pipeline`
Purpose: Track which of 3 touches were sent, when follow-ups are due.

```sql
create table public.prospect_outreach_pipeline (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null unique references public.outreach_leads(id) on delete cascade,
  
  -- Touch sequence (3-touch cadence per decisions-log 2026-08-12)
  first_touch_sent_at timestamptz,
  first_touch_drafted_at timestamptz,
  follow_up_1_sent_at timestamptz,              -- ~3 days after first
  follow_up_1_drafted_at timestamptz,
  follow_up_2_sent_at timestamptz,              -- ~7 days after first
  follow_up_2_drafted_at timestamptz,
  
  -- Exit conditions (stop cadence)
  reply_received_at timestamptz,                -- Any reply stops follow-ups
  opted_out_at timestamptz,                    -- Hard opt-out
  demo_tried_at timestamptz,                   -- Completed demo (via demo_token)
  
  -- Next action
  next_action_due_at timestamptz,               -- When to send next touch
  next_action_type text,                        -- 'first_touch' / 'follow_up_1' / 'follow_up_2' / 'none'
  
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_prospect_pipeline_next_action on prospect_outreach_pipeline(next_action_due_at)
  where next_action_type is not null;
```

### New Table: `outreach_signal_evidence`
Purpose: Store the *specific observed facts* that led to a qualification signal.

```sql
create table public.outreach_signal_evidence (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.outreach_leads(id) on delete cascade,
  
  -- The signal this evidence supports
  signal_type text not null, -- 'response_slowness', 'message_volume', 'catalog_stable', 'meta_access', 'contact_verified'
  
  -- The evidence itself (specific, observable)
  evidence_description text not null,          -- "Instagram has 12 unanswered DMs over 2 days"
  evidence_source text,                        -- 'web_observation' / 'direct_question' / 'social_scan' / 'referral'
  evidence_url text,                           -- Link to the observation if applicable
  
  -- Scoring impact
  signal_weight integer default 1,             -- Points this evidence contributes to qualification_score
  confidence text not null default 'medium',  -- 'high' / 'medium' / 'low'
  
  created_at timestamptz not null default now()
);

create index idx_signal_evidence_lead on outreach_signal_evidence(lead_id);
create index idx_signal_evidence_type on outreach_signal_evidence(signal_type);
```

---

## 4. Qualification Scoring Algorithm

**Goal:** Explainable, signal-based score (0-100) that predicts likelihood of:
- Replying to outreach
- Booking a demo
- Converting to paid

### Scoring Inputs (by weight)

| Signal | Points | Evidence | Notes |
|--------|--------|----------|-------|
| **Response slowness observed** | 15 | Social media replies lag, visible backlog | High confidence = +5 bonus |
| **High message volume** | 15 | "Multiple channels active", inquiries pile up | Reduces owner's time-per-message |
| **Catalog stability** | 10 | "Prices same week-to-week" or "Standard services" | Enables Caye to answer directly |
| **Meta access verified** | 10 | Owner confirms can log into own Meta | Critical gating signal |
| **Multiple inbound channels** | 10 | Email + WhatsApp + IG (at least 2) | Expands Caye's operational surface |
| **Specific pain articulated** | 10 | "Lost a booking" or "Owner drowning" | Observed, not assumed |
| **Tour operator vertical** | 5 | Proven ICP fit (Bimini pilot) | Baseline category fit |
| **Caribbean geography** | 5 | Bahamas/Jamaica/T&T/Barbados | Trust/market fit |
| **Separate business line** | 5 | Business WhatsApp ≠ personal phone | Enables guest-facing Cloud API |

**Malus (subtract points)**
| Disqualifier | Penalty | Notes |
|--------------|---------|-------|
| Cannot access Meta | -25 | Onboarding blocker (Dave lesson) |
| Project/custom business | -20 | Needs back-office, not front-desk |
| No demonstrated inbound | -15 | No pain = no $79 motivation |
| Unknown/untraceable owner | -10 | Outreach likely to bounce |

**Formula:**
```
base_score = sum(signal_points) + sum(malus)
qualification_score = clamp(base_score, 0, 100)
```

**Tiers (for sorting/prioritization):**
- **80–100:** Excellent fit, immediate follow-up
- **60–79:** Good fit, standard cadence
- **40–59:** Moderate fit, lower priority
- **0–39:** Weak fit or disqualified

---

## 5. Measurement & Reporting

### Daily Digest (WhatsApp, Caye Direct)
```
Outreach daily digest:
Sourced: 5 leads (Nassau tour ops)
Contacted: 2 first-touches
Followed up: 1 lead (touch #2)
Replies: 1 (Eleuthera Car Rental — warm connection)
Tried demo: 0
Qualified: 3/5 sourced (60% qualification rate)
Score distribution: 1 excellent (80+), 2 good (60-79)
```

### Weekly Report (markdown in repo)
| Metric | Week 1 | Week 2 | Trend |
|--------|--------|---------|-------|
| Sourced (total) | 35 | 42 | ↑ |
| Qualified (≥40) | 28 (80%) | 31 (74%) | ↓ (stricter scoring?) |
| Excellent (≥80) | 4 | 6 | ↑ |
| Contacted (first-touch sent) | 28 | 31 | ↑ |
| Replies | 3 (10.7%) | 4 (12.9%) | ↑ |
| Demo tries | 1 | 2 | ↑ |
| Converted to paid | 0 | 0 | — |

### Funnel Metrics (dashboard card)
```
Sourced → Qualified → Contacted → Replied → Tried → Converted
   58          48         48          6        2         0
        83%        100%        12.5%   33%      0%
```

### Cohort Analysis (by vertical/region)
Which vertical×region combos have:
- Highest qualification rate (% of sourced that score ≥40)
- Highest reply rate (% of contacted that reply)
- Highest demo-try rate

---

## 6. Implementation Phases

### Phase 1: Schema & Qualification (this PR)
- [ ] Create prospect_qualifications table
- [ ] Create prospect_outreach_pipeline table
- [ ] Create outreach_signal_evidence table
- [ ] Extend outreach_leads with vertical/region/source/stage
- [ ] Write qualification scoring logic (pure function, testable)
- [ ] Build qualification assessment tool (async job to re-score existing leads)

### Phase 2: Sourcing Integration
- [ ] Update source-leads.ts to populate qualification fields at import
- [ ] Add qualification signal detection to Place API results
- [ ] Hook qualification scoring into the daily sourcing cron

### Phase 3: Pipeline & Cadence
- [ ] Implement 3-touch cadence (first-touch, +3 days, +7 days) in prospect_outreach_pipeline
- [ ] Update nudge cron to check next_action_due_at
- [ ] Build demo-tried signal detection (via demo_token hits)

### Phase 4: Measurement & Dashboard
- [ ] Daily digest generation (send to Caye Direct WhatsApp)
- [ ] Weekly report to repo (outreach-metrics.md)
- [ ] Founder dashboard: prospects by tier, qualification score distribution

### Phase 5: Feedback Loop
- [ ] Compare qualification score vs. actual reply rate
- [ ] Adjust signal weights based on real performance
- [ ] Identify and document new verticals/regions with positive reply rates

---

## 7. Success Criteria

### For this PR (Phase 1)
- [ ] Schema can store complete qualification data per prospect
- [ ] Scoring algorithm is pure-function testable
- [ ] Existing ~461 leads can be back-filled with source/vertical/region (from tracker + Excel)
- [ ] No changes to autonomous sending behavior or cadence
- [ ] Documentation updated with qualification framework

### Ongoing (post-implementation)
- [ ] **Qualified prospect volume:** ≥20/week hitting qualified pool (≥40 score)
- [ ] **Reply rate:** 12%+ on contacts to ≥60 score leads (vs current ~10%)
- [ ] **Demo book rate:** 3+ demos/100 qualified contacts
- [ ] **Conversion rate:** 1 new paid customer per 50 qualified contacts (comparable to Bimini pilot trust rate)

---

## 8. Open Questions for Founder Review

1. **Score threshold for "qualified":** Is 40 the right floor, or should it be 50/60?
2. **Signal weights:** Which signals matter most to reply rate? (Should be calibrated post-launch.)
3. **Geographic expansion:** Once Caribbean base rate is solid, which regions next? (Decided: US-mainland OK post 2026-07-28, but sourcing drift was not blessed.)
4. **Vertical diversification:** Restaurants/salons showing in log (2026-07-25+) — expand targeting intentionally, or consolidate back to tour ops first?
5. **Contact channel strategy:** Should WhatsApp (guest-facing) be a prerequisite for Caribbean leads, or is email+IG enough to start?

---

## 9. References
- [ICP.md](../../Products/Caye/ICP.md) — Ideal Customer Profile, proven fit signals
- [STATE.md](../../Products/Caye/STATE.md) — Product state, broken/friction section
- [decisions-log.md](../../_Ops/Brain/decisions-log.md) — 2026-08-12 autonomous outreach spec
- [outreach-tracker.md](../../_Ops/Outreach/outreach-tracker.md) — Manual log of 461 sends + responses
- [caribbean-tour-operator-leads.xlsx](../../_Ops/Outreach/caribbean-tour-operator-leads.xlsx) — 271 sourced leads
