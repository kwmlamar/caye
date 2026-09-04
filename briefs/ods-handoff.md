# ODS × Caye — session handoff

**Written 2026-09-03. Freight section corrected, then revised again, the same day; delivery,
environment and traps sections updated after PRs #469/#471/#472 merged.** Read this first if you are picking up the ODS work on a new machine
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

**Merged 2026-09-03, later the same day**, PRs #469, #471, #472 — `main` at `aa1ec3af`:

- **Delivery** — `lib/attention-delivery.ts` + `lib/construction-attention-delivery.ts`,
  the last hop. Until this, every construction producer raised attention and nothing ever
  turned it into a message: the receivables sweep computed the whole weekly ask, wrote it
  to `caye_owner_attention`, and stopped. No construction producer reached `enqueueOutbound`
  at all. Reads the ledger's own `state_fingerprint` vs `notified_fingerprint` — the
  comparison the schema was built around — so no producer needed changing, and an invoice
  is delivered once rather than nagging daily (age is deliberately excluded from the
  receivable fingerprint).
- **A customer-facing safety fix** — the front-desk guard did not fire on the 2026-08-20
  (Charissa) case it was written for. Three defects, not one: an honorific split the
  sentence, `sentencePromisesTransfer` matched only bare stems so "will be **sending**" was
  never seen as a promise, and fixing that alone would have made the grounding "The invoice
  has not yet been sent." read as *authorising* the promise. `NEGATION_RE` is now split —
  narrow refusal set for the reply body, wider perfect/passive set for grounding.
- **Six production defects** #470 had found and left failing, plus a seventh underneath
  them in `canonicalPropertyKey`.

**Merged 2026-09-03, PRs #475/#476** — `main` at `41b3a568`, production deploy success:

- **Receipt capture** — the money-out half of job costing. A photographed
  receipt now reaches the ledger with its image attached, gated behind
  confirmation. See §6 for the four constraints that shaped it.

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

**As of 2026-09-03 this is the ONLY thing left.** The delivery code shipped in #472, so the
chain now runs end to end and stops precisely at this flag. Flipping it and setting a
verified number is sufficient — there is no remaining build. That is also why it was safe
to merge the delivery hop before the decision was made: with `notifications_paused` set,
the whole path runs and enqueues nothing.

**It needs a decision, not code: who receives the first unprompted message.** Wallace is the
bottleneck the attention ledger was designed around; Omar and Jay are now allowlisted too.
Lamar was deciding. **Do not flip those flags without him.**

Also pending: **Omar (operator 35) has not verified** — Jay (34) since has. Omar needs to
reply to the WhatsApp verification template once. Until then the webhook drops his messages
*and* every estimate/pricing attention item routes nowhere, because routing refuses to hand
an unverified operator anything rather than falling back to someone else.

## 6. Remaining work, in priority order

~~1. **The Friday ask.**~~ ~~2. **`caye_outbound_queue` has no construction `kind`.**~~
   **Both done 2026-09-03 (PR #472, `aa1ec3af`).** The delivery hop exists:
   `lib/attention-delivery.ts` (routed item → queued message, domain-agnostic) and
   `lib/construction-attention-delivery.ts` (reads the ledger for what nobody has been
   told), wired as a fourth independent step in `construction-ledger-cycle.ts`. The
   `construction_attention` kind and its CHECK migration landed together.

   **It sends nothing today, by design.** `enqueueOutbound` hard-gates on
   `notifications_paused`, so the step runs end to end and enqueues zero rows. §5 is now
   the *only* thing between ODS and the loop working — it is a flag flip and a phone
   number, not a build. Nothing else is waiting on code.

   Two things worth knowing before extending it. It is scoped to receivables on purpose:
   turning on payroll, purchase orders, projects, receipts or freight is adding a subject
   type to `DELIVERABLE_SUBJECT_TYPES`, not writing a second path. And the migration is
   written but **not applied** — it must be applied before the first `construction_attention`
   row is enqueued, or the insert is silently rejected by the CHECK. There is no ordering
   hazard while notifications stay paused.

~~1. **Receipt capture by photo.**~~ **DONE 2026-09-03 (PRs #475, #476, `41b3a568`).**
   Photo arrives -> Caye reads it -> proposes what she actually saw -> a human
   confirms -> the photo is fetched from Meta, stored in TropiTrack's
   `documents` bucket, and the receipt row written with an audit entry.

   *The premise this file carried was wrong: it said this needed a WhatsApp
   media pipeline. One already existed and was live* (`lib/whatsapp/media.ts`,
   `image-burst.ts`, wired into the operator webhook for both images and PDFs).

   Four things the next person should know:

   - **`receipts.image_url` is NOT NULL with no default.** A receipt row cannot
     exist without a stored image, which is why the write boundary now does a
     storage write at all (`uploadReceiptImage`). It stays append-only:
     `upsert: false`, never overwrites, never deletes.
   - **All six pre-existing receipts have `image_url` = the literal string
     `'uploaded'`,** and `receipt_line_items` has zero rows. TropiTrack's own
     flow never stored an image either. Writing that placeholder was refused
     deliberately: it asserts an upload that did not happen.
   - **The media HANDLE is persisted, not the bytes** (`caye_operator_messages
     .inbound_media`). The confirmation lands on a later turn, by which point
     the model no longer has the image, so the tool re-fetches from Meta at
     write time. Uploading eagerly would put unconfirmed photos into another
     company's storage before anyone approved them.
   - **The accepted mime types are not the set Caye can read.** `image/gif` is
     model-readable but bucket-rejected; `image/heic` (iPhone's default) is
     bucket-accepted but model-unreadable. A caller must satisfy both.

   **Migration `20260903b_operator_message_inbound_media.sql` WAS APPLIED to
   the Caye project on 2026-09-03**, before merging, under explicit one-off
   authorization from Lamar. Verified after: `inbound_media jsonb`, nullable,
   3,954 existing rows untouched. It had to go first — the webhook writes that
   column on every inbound image, and without it the insert fails, image rows
   stop persisting, and `decideImageBurst` (which reads the previous image row)
   would see every photo as the first, bringing back the eleven-replies
   incident. `20260903_add_construction_attention_outbound_kind.sql` from #472
   is still **NOT applied** and must be before any `construction_attention` row
   is enqueued.

   Still open: **PDF receipts.** `handleDocumentInbound` does not carry a media
   handle, so a PDF cannot be logged this way even though the bucket accepts
   `application/pdf`. Images only.

2. **Freight — mostly built, but nobody is told.** *Corrected 2026-09-03: an earlier version
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

   **Both of the "also open" items below are now FIXED on `main`** (they were, as of
   2026-09-03): the relation write goes through `freightRequestEntityId()` rather than a
   `freight:<uuid>` string into a `uuid not null` column, and references are generalised to
   `FreightReference { kind, value }` with `kind` covering `dock_receipt | warehouse_number
   | shipment_ref`. `FreightDocumentData` no longer carries `dockReceiptNumber` at all;
   `FreightRequest.dockReceiptNumber` survives only as a demoted legacy field, with a
   comment saying not to write new logic against it.

   **PR #436 (WhatsApp freight orchestration) is the piece that closes the "nobody is told"
   half — and it must NOT be merged as-is.** Reviewed 2026-09-03, full findings in a comment
   on the PR. It predates both fixes above and has 16 reads of `dockReceiptNumber` and zero
   of `reference`. It would still *compile*, because the demoted field remains — and would
   silently break for TWINex, which is half of ODS's freight: `freight-null.pdf` filenames,
   labels reading "Dock Receipt null", no warehouse number exposed to the agent at all, and
   a WhatsApp reply carrying no identifier. Worse, it reintroduces the relation-write bug
   verbatim.

   Do not close it either. `main` still has **no freight agent tool whatsoever** (confirmed
   by `git ls-tree lib/caye-agent/tools/`). #436 adds exactly the missing surface — a read
   tool, a write-low prepare, and an owner-gated write-high send — plus the
   `server-operations.ts` extraction that keeps WhatsApp and the dashboard on one
   implementation. Rework it against `reference`; the four concrete steps are in the PR
   comment.
3. **RLS is disabled on 9 TropiTrack tables** (`estimates`, `receipts`, `materials`,
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

**A migration that a webhook writes to MUST be applied before the code
deploys.** Merging to `main` deploys to production. `caye_operator_messages`'s
insert in `handleImageInbound` discarded its error (supabase-js returns rather
than throws), so a missing column meant image rows silently stopped
persisting — and `decideImageBurst` reads the previous image row, so every
photo would look like the first and the eleven-replies incident would return.
The insert now logs its error, which is what makes such a lag visible. Check
`information_schema.columns` before merging anything whose runtime path writes
a new column.

**The outbound-kind constraint has THREE mirrors, not two.** This file used to say two.
Adding a kind means updating `lib/whatsapp/outbound.ts`'s `OutboundKind` union, the CHECK
migration (drop+add full redefinition — the sync test reads only the newest file), *and*
`lib/db-enum-literals.test.ts`'s hand-maintained `OUTBOUND_KIND_VALUES` set, which
`lib/db/check-constraints.test.ts` compares against the live constraint. The first two go
green on their own and the third fails only in the full suite, which is exactly how it gets
missed. `outbound-kind-migration-sync.test.ts`'s own header names the reason: a
hand-maintained mirror does not stop drift, it relocates where the next drift goes
unnoticed. Also update `check-constraints.test.ts`'s multi-line parser case, which pins a
count to whichever migration most recently redefined the constraint.

**`npm run build` cannot be verified with the `git archive` + symlinked `node_modules`
trick.** Turbopack rejects a `node_modules` symlink pointing outside the project root and
dies with a panic that looks like a real build failure but is not. `npx tsc --noEmit` and
`npx vitest run` are fine that way; the build is not. The `Autumn attention lifecycle`
workflow runs `npm ci` + `npm run build` on a real checkout and triggers on
`supabase/migrations/**`, so a migration-touching PR gets the build checked in CI. It is
not a required check — wait for it anyway when the change touches attention, notification,
or migrations, because it is the only place the build actually runs.

**`UNSTABLE` is not always a failure.** It also shows while a non-required check is still
*pending*. Read `gh pr checks` before concluding anything.

**Five test failures are pre-existing** — `confirm-pending-action`, `recover-outreach-operations`,
`inspect-job-search-applications`. Incomplete Supabase test doubles; see the
`fix/*-supabase-test-double` branches. Verified identical against baseline. Do not chase them.

## 8. Environment

- **Original machine:** Node lives at `~/.local/node/bin` and is **not on PATH** —
  `export PATH="$HOME/.local/node/bin:$PATH"`. Verify on any new machine; this is local, not
  a repo property.
- **There is no `.env` in this repo.** Nothing local can reach Supabase or an LLM. All tests
  inject fakes. Do not ask for the production `.env`.
- **`gh` is installed and authenticated** at `~/.local/gh/bin` (also not on PATH), as
  `kwmlamar`. *This reverses what this file said before 2026-09-03 — it used to say GitHub
  operations had to be handed to a ChatGPT operator.* Opening, reviewing, commenting on and
  merging PRs all work directly. **Never ask for a token.**
- **`main` is protected by ruleset 22164101:** `strict_required_status_checks_policy = true`,
  zero bypass actors, and exactly ONE required check — `Employee Eval v1 gate`. Strict mode
  makes merges **serial**: a branch behind `main` shows its required check as `expected`
  forever, which is not a check-name mismatch. Rebase → push → wait → merge, one at a time.
  Merging PR A therefore costs PR B a rebase and a full re-run, so when several small
  changes are ready, cherry-pick them onto one branch rather than opening one PR each.
- `npx tsc --noEmit` is the canonical typecheck; there is no `typecheck` script. **Run it
  unfiltered** — it is not a required check, and a tsc-breaking change has reached `main`
  through that gap before.
- **Verify the COMMITTED TREE, not the working directory** — `git archive HEAD | tar -x -C
  <dir>` then symlink `node_modules` in. This has already caught a file that was never
  `git add`ed. See §7 for the one thing this method cannot check (`npm run build`).

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
