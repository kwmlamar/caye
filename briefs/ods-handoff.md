# ODS × Caye — session handoff

**Written 2026-09-03, freight section corrected the same day.** Read this first if you are picking up the ODS work on a new machine
or in a new session. It carries the state, the decisions still open, and the things that
have already gone wrong once.

Local Claude memory does not travel between machines, which is why this is in the repo.

---

## 1. What this work is

ODS Construction is a Bahamian residential contractor. A Sept 2026 audit
(`~/Downloads/ODS_Current_State_Operating_Model.md` on the original machine — **not in this
repo**, ask Lamar for it) reconstructed 37 workflows from primary evidence and found one
failure repeated throughout:

> Work is done correctly and the last step is missed. 79 abandoned drafts, 56 with empty
> bodies. An unsigned contract escalated weekly into an inbox that is 87% unread.

The whole build is aimed at that: **not more detection — delivery and confirmation.**

Two corrections to the audit, established from the databases and worth knowing:

- **Jay operates a real system.** The audit says he does nothing; he has entered 1,529
  timesheet rows weekly since 27 Jan 2026 and runs payroll. It could not see TropiTrack.
- **Half of job costing exists.** 3,883 time entries over 16 months. The missing half is
  money-out, not labour.

## 2. The shape

```
TropiTrack (Supabase, "Bedrock")   the ledger — system of record for construction objects
        ↕ read adapter + insert-only write provider
Caye (Supabase + Next.js)          the employee — perception, attention, follow-through
        ↕ WhatsApp
Wallace · Omar · Jay
```

Caye is never a second copy of the ledger. Every answer cites a ledger row.

## 3. Identifiers you will need

| Thing | Value |
|---|---|
| Caye Supabase project | `fetsfbdltlxjsomiqvrw` |
| TropiTrack Supabase project | `rrqpwtggiirexptnhyqy` (internal codename **Bedrock**) |
| Caye workspace (ODS) | `5a21a758-ed47-4de7-bd93-6ddd8578d739` |
| TropiTrack company | `4ee41a41-7790-4e26-8d3c-e8ce66ab38a3` |
| Binding row | `domain_source_connections` `80137a69-39a6-460f-91b3-7fb6729ad832` |
| Credential | env `DOMAIN_SECRET_BEDROCK_ODS` (TropiTrack service-role key) |

Operator → ledger profile mappings live in that row's `config.operator_profiles`, keyed by
`operator_allowlist.id`: `31`→Lamar, `32`→Wallace, `34`→Jay, `35`→Omar.

**Grep for `bedrock`, not `tropitrack`.**

## 4. What is built and live

Merged to `main` across PRs #454–#459:

- **Perception** — five change streams (purchase orders, projects, estimates, receipts, pay
  periods), polled every 30 min by `/api/caye/construction-ledger-sync`.
- **Delivery** — `lib/domain-attention.ts` turns ledger changes into owner-attention items.
- **Read** — `find_job`, `get_job`, `get_job_labor`, `get_payroll_status`. **Verified live
  over WhatsApp**: contract values, labour costs to the cent, and ambiguous names asked
  about rather than guessed.
- **Write** — `preview_crew_day` + `log_crew_day`. Insert-only boundary, gated, verified
  after write.
- **Adaptivity** — `lib/domain-policy.ts`. Business assumptions live in the workspace, not
  in constants; Caye asks about one at a time and remembers the answer.

**Merged 2026-09-03**, PRs #460, #465, #451 — production deploy `f7e420fc`, status success:

- **Receivables** — `get_receivables`, `log_invoice_sent`, `record_payment`, the weekly ask,
  and the payroll-owed fix. `get_payroll_owed` takes a date range and **never** a pay-period
  id: the real answer is **$15,313.45** owed (`net_pay - total_paid`), not the naive
  $24,298.45 a sum of gross would report.
- **Freight** — the relation UUID fix (every freight relation write had been failing since it
  shipped), TWINex/warehouse-number generalisation, and freight attention.
- **Routing** — `lib/attention-routing.ts`, wired to live config (see below).

**Live routing, verified against the real roster and config:**

| item | goes to |
|---|---|
| payroll change | Jay (34) |
| estimate change | *unrouted* — Omar (35) is unverified |
| project / PO / receivable, routine | Lamar (31) |
| PO or receivable at decision/critical | Wallace (32) |

`domain_source_connections.config.operator_roles` on connection `80137a69` now reads
`{owner: 32, office: 31, hr: 34, estimator: 35}`. Note operator 31's WhatsApp display name
reads "Wallace Sineus." but the ledger profile is **Lamar** (`classicalsineus@`); 32 is
Wallace Sr. (`whelsco@`), 34 is Jay (`jaysineus@`). Getting those two backwards would send
every money decision to the wrong person.

## 5. The one thing blocking everything

**Caye cannot send anything unprompted to ODS.**

```
workspace_ai_config:  notifications_paused = true
                      operator_whatsapp_number = null
                      operator_whatsapp_verified_at = null
```

`enqueueOutbound` hard-gates on `notifications_paused`; the morning-digest cron only selects
workspaces with a verified number. So the cron polls, changes are detected, attention items
are raised — and it stops at the last hop.

That is the audit's own failure reproduced one layer out. Everything else is downstream of
fixing it.

**It needs a decision, not code: who receives the first unprompted message.** Wallace is the
bottleneck the attention ledger was designed around; Omar and Jay are now allowlisted too.
Lamar was deciding. **Do not flip those flags without him.**

Also pending: **Omar (operator 35) has not verified** — Jay (34) since has. Omar needs to
reply to the WhatsApp verification template once. Until then the webhook drops his messages
*and* every estimate/pricing attention item routes nowhere, because routing refuses to hand
an unverified operator anything rather than falling back to someone else.

## 6. Remaining work, in priority order

1. **The Friday ask.** Nothing yet prompts payment confirmation. `record_payment` exists but
   waits to be told. This is the loop that actually recovers the ~$94,000, and it needs §5
   resolved first.
2. **`caye_outbound_queue` has no construction `kind`.** Adding one needs BOTH the
   TypeScript `OutboundKind` union and a migration extending the CHECK — they are asserted
   in lockstep by an existing test, and three past migrations exist because someone changed
   only one side and broke escalation delivery.
3. **Receipt capture by photo.** The money-out half of job costing: 3,883 timesheet rows
   against 6 receipts. Needs a WhatsApp media pipeline; the `receipts` change source already
   detects them once they exist.
4. **Freight — mostly built, but nobody is told.** *Corrected 2026-09-03: an earlier version
   of this file said freight was untouched. It is not.* `lib/freight/` implements
   detect → match → generate a PDF from verified evidence → owner-gated send, and
   `/api/email/gmail-cron` runs the detection and attachment ingestion every five minutes.
   As of writing there were **1,182 ingested ODS artifacts and 1,177 parsed email-evidence
   observations** in production, so the passive half genuinely works.

   What is missing is the half that matters: **no agent tool** (grep `lib/caye-agent/` for
   freight — nothing) and **no notification**. The only way to reach it is for Wallace to
   remember to open the dashboard sidebar link with `?freightReview=1`. That is the audit's
   own finding rebuilt — correct detection reported into a place nobody opens — while he
   keeps doing the job by hand fifteen times a month.

   Also open: `business_artifact_relations.target_entity_id` is `uuid not null`, but the
   freight code writes `freight:<uuid>` strings into it. **Verified against production:
   0 freight relations out of 2,354.** Every freight relation write has been failing since
   it shipped. Fix by writing the underlying message UUID and letting `target_entity_type`
   carry the distinction — the prefix is redundant. And confirm TWINex "warehouse number"
   actually matches `detection.ts`'s patterns; only dock-receipt and shipment-ref forms are
   clearly handled, and TWINex is half of ODS's freight traffic.
5. **RLS is disabled on 9 TropiTrack tables** (`estimates`, `receipts`, `materials`,
   `estimate_line_items` and others) — flagged by Supabase's own advisor. The adapter treats
   TropiTrack RLS as defence-in-depth only and relies on its own company scoping, which is
   sound, but the gap is real and independent of this work.

## 7. Things that have already gone wrong — do not repeat

**Parallel agents share one working tree.** Never let a subagent run `git checkout`. Two
sessions of damage came from this. Tell them explicitly: *do not create, switch, or checkout
any branch; do not commit or push.*

**Dispatching against a branch that lacks its dependency.** A subagent was told to extend
`write-provider.ts` on a branch where it did not exist yet. It correctly refused rather than
inventing the base class — that is the repo's own rule and it saved real damage. Check what
is actually on the branch before dispatching.

**`mergeable_state` is computed lazily.** A `clean` read before another PR merges goes stale
and becomes `behind`. Re-read immediately before merging. Rebase stacked branches
*proactively* after each merge rather than discovering it at the merge button.

**A clean rebase is not a correct one.** When two branches touched the same file, verify both
sides' changes survived rather than trusting git's silence.

**Typecheck the committed tree, not the working directory.** One commit missed a file and
would not have built:

```bash
TMP=$(mktemp -d); git archive HEAD | tar -x -C "$TMP"
ln -s "$PWD/node_modules" "$TMP/node_modules"
(cd "$TMP" && npx tsc --noEmit)
```

**Five test failures are pre-existing** — `confirm-pending-action`, `recover-outreach-operations`,
`inspect-job-search-applications`. Incomplete Supabase test doubles; see the
`fix/*-supabase-test-double` branches. Verified identical against baseline. Do not chase them.

## 8. Environment

- **Original machine:** Node lives at `~/.local/node/bin` and is **not on PATH** —
  `export PATH="$HOME/.local/node/bin:$PATH"`. Verify on any new machine; this is local, not
  a repo property.
- **There is no `.env` in this repo.** Nothing local can reach Supabase or an LLM. All tests
  inject fakes. Do not ask for the production `.env`.
- **Claude Code cannot open or merge PRs here** — no `gh`, no token, and `main` is protected
  behind the `Employee Eval v1 gate`. Branches are pushed over SSH and GitHub operations are
  handed to a ChatGPT operator with an explicit task block. Never ask for a token.
- `npx tsc --noEmit` is the canonical typecheck; there is no `typecheck` script.

## 9. Design rules worth not relitigating

- **The bank is the arbiter and it is in no system.** A payment row is a human attestation.
  A client's promise is never a payment.
- **Ask about intent, never about identifiers.** Caye asking a human for a pay-period ID was
  a real bug, caught in live testing.
- **A receipt is not proof.** Every write is re-read and reported as *verified*, not
  *attempted*.
- **Bootstrap is never news.** First sight of an existing record must not announce itself, or
  connecting a ledger delivers sixteen months of false alerts on day one.
- **Defaults are visible.** Every policy value carries whether it came from the workspace or
  a shipped default. A default the owner never sees is a decision they never got to make.
- **The write boundary is insert-only** and should stay that way. TropiTrack's own triggers
  recalculate invoice totals on payment insert, so no update path is needed.
