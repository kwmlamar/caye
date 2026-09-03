# ODS WhatsApp Operating Surface

## Status

Product spec for `feat/ods-whatsapp-operating-surface`. Written before implementation so the
engineering contract (`tropitrack-ledger-adapter.md`) and any agent picking this up have
fixed product semantics to build against.

Target state, not next sprint. Milestone 1 is scoped at the end.

## Goal

**WhatsApp is the whole interface for ODS Construction.** Wallace, Omar and Jay each do their
entire job from the thread they already have open, in the app they already use, without being
sent to a dashboard, a spreadsheet, or a folder tree.

Caye is not a chatbot in front of a database. She is the employee who holds the state, asks
the question whose answer is missing, and refuses to record something as done until she has
seen that it is done.

## Why this shape

The ODS current-state audit (Sept 2026, 37 workflows) found one failure repeated 37 times:
**work is done correctly and the last step is missed.** 79 abandoned drafts, 56 of them empty.
An unsigned contract escalated weekly into an inbox that is 87% unread. A corrected landed-cost
recipe written on 27 July and not applied to the job priced on 20 August.

Two consequences for design:

1. **Another place to type is not the answer.** Every ODS register kept as `.xlsx` is 19–29 days
   stale; every register kept as `.md`/`.csv` is current. The difference is whether a human has
   to go somewhere and type. A new app becomes the eighth stale register.
2. **The system must ask, not wait.** ODS's systems all wait to be updated. Caye's job is to
   ask the one question whose answer is missing — *"is the Christiansen cistern done?"* — and
   put the answer where it belongs.

WhatsApp is chosen because it is already where ODS's real coordination happens (workflows 11,
12, 20, 34 in the audit are WhatsApp-and-in-person only), and because it accepts the three
input types a construction crew actually produces: **a sentence, a photo, and a voice note.**

## Product principles

- **Capture in one message, not one row.** Omar reporting a crew day must not be ten messages.
  One sentence produces a full draft; the human confirms once. Default-and-confirm beats
  type-each-field.
- **Never send anyone elsewhere to do work Caye can take.** For list-shaped answers she gives
  the top few in the thread and offers the rest. She never replies "log in and check."
- **Voice notes and photos are first-class inputs,** not attachments to a text flow. Wallace
  already dictates 3,000-word meeting notes into his phone; that should land as structured
  scope, selections and commitments.
- **Every write is propose → confirm → commit → verify.** A confirmation is not evidence of
  effect. Nothing is reported as done until independently re-read.
- **Every staged draft carries a clock.** An unsent draft past its clock escalates. It must
  never become a new place for finished work to die — that is the failure mode this replaces.
- **Role decides the toolset**, via `operator_allowlist.decision_scopes`. Omar sees field
  tools, Jay sees money tools, Wallace sees everything. Nobody sees another workspace.
- **Caye is never a second copy.** Every answer cites a ledger row and can be re-read on demand.

## The three operators

### Omar — field / project manager
Runs the crews. Leaves no institutional record today. Receives the King Ocean and Mikro freight
mail directly and cannot action it because there is nowhere to file the result.

| Use case | What he sends | What Caye does |
|---|---|---|
| **Daily crew log** | *"Blue Sky today — me, Cyril, Dwight, 7 to 4. Cyril left at 2."* | Resolves project + workers, drafts every timesheet row for the day, returns one summary to confirm. **One message, ten rows.** |
| **Site status answer** | Replies to Caye's question | Writes the answer to the scope item and clears the attention entry |
| **Progress photos** | Photos, no caption needed | Files to the right project under one naming convention; flags any client who has asked for photos and not received them |
| **Materials landed** | *"Trex came in today"* | Marks the shipment delivered; releases anything blocked on it |
| **Freight loop** | Forwards or confirms a dock receipt | Finds the matching vendor invoice, drafts the reply **with the attachment**, sends on his confirm |
| **Field verification** | *"patio came out 640 sq ft"* | Records actual quantity against the estimate line |
| **Blocker** | *"out of thinset at Blue Sky"* | Opens an attention item with an owner and a clock |

### Jay — accountant / admin
Already operates TropiTrack's payroll ledger weekly and has done for seven months (1,529
timesheet rows since 27 Jan 2026). He is the proven operator, not a hypothetical one.

| Use case | What he sends | What Caye does |
|---|---|---|
| **Confirm the day** | *"yes"* / *"Cyril was 8 not 6"* | Commits or corrects Omar's drafted timesheet rows |
| **Run payroll** | *"run the pay period"* | Computes gross/NIB/net from committed hours, shows totals, commits on approval |
| **Issue an invoice** | *"invoice Christiansen the 40%"* | Drafts from the payment schedule, one numbering scheme, logs it the moment it sends |
| **Confirm payments** ⚑ | Answers Caye's weekly question | Sets the **confirmed-received** flag — human-only, because no bank connects. This is the ~$94,178 problem. |
| **Capture a receipt** | Photo of a receipt | Extracts vendor, amount, date; asks only for project + cost code. **This is the missing half of job costing and it is a camera-shaped task.** |
| **Payables** | *"did we pay Virginia Tile?"* | Answers from the ledger, or says plainly that it is unconfirmed |
| **Chase** | *"yes send it"* | Drafts the chase mail for an aged invoice; sends on approval |

### Wallace — owner
Router for every decision today. The goal is to leave him the decisions and take everything else.

| Use case | What he sends | What Caye does |
|---|---|---|
| **Morning briefing** | nothing — she opens | The three things that matter, with ages. Unchanged items say "still open", never re-surface as new. |
| **Ask anything** | *"what does Christiansen owe?"* · *"how many hours went into the Capricorn forms?"* | Answers from the ledger with a citation. The second question is worth ~$10,100 on the Wockenfuss quote and is unanswerable today. |
| **Approve** | *"send it"* | Commits the staged action and verifies the effect |
| **Price a job** | *"price the Wockenfuss pool at 15×28"* | Dispatches a deep job; returns with backup and assumptions named |
| **Capture a commitment** | *"told Eric we'd sort the water pressure"* | Creates a tracked, unpriced commitment. Retractable screens have been unpriced for 113 days. |
| **Dictate** | voice note after a site meeting | Extracts scope, selections, decisions and commitments; files them; asks about anything ambiguous |
| **Nothing falls** | — | Every draft has a clock; past it, she escalates rather than letting it settle |

## Mechanics that apply to every use case

**Entity resolution.** WhatsApp input is informal. *"Blue Sky"*, *"the Mann job"*, *"Eric's
garage"* are the same project; *"Cyril"* is a worker with no surname in any message. Resolution
is a first-class component, not string matching — and when it is not confident it **asks**
rather than guessing. Wrong-project attribution silently corrupts job costing, which is the
one thing this system exists to make trustworthy.

**Ambiguity is surfaced, never resolved silently.** Christiansen has two concurrent jobs; an
unlabelled wire cannot be allocated. Caye asks which one. The audit's own warning applies:
where two records disagree, show both and flag the conflict.

**Confirmation is per-risk, not per-message.** Reading is free. Logging a fact is low-risk.
Committing payroll, sending a client email, or setting a payment as received are high-risk and
route through the existing gate.

**Nothing ODS-specific enters the transport or prompt layers.** Dock receipts, landed cost and
cost codes are ledger concepts, reached through the adapter. The kernel does not learn what a
dock receipt is.

## Out of scope

- Client-facing WhatsApp. This is a back-office surface. ODS's inbound is answered well; the
  failures are outbound and internal.
- Replacing the TropiTrack web app. It remains correct for bulk review and correction. Caye
  covers capture, question, decision and follow-through.
- Autonomous sending. Every customer-facing send stays behind the draft-before-send gate.

## Milestone 1 — scope

**"Caye can see and speak about ODS's real job data."** No writes. Ships nothing a person can
see except correct answers, and unblocks every use case above.

1. Read-only TropiTrack ledger adapter (see `tropitrack-ledger-adapter.md`).
2. Entity resolution for project, worker, client, vendor — including the ask-when-unsure path.
3. Read tools registered for the ODS workspace only: project state, hours by project/worker/date
   range, payroll period status, estimate and contract value, client and vendor lookup.
4. Ledger change feed into `workspace_events`, so a database change and an email are the same
   kind of thing to her.

**Acceptance:** over WhatsApp, Wallace can ask *"how many hours have we put into Capricorn?"*
and *"what's the contract value on Christiansen?"* and get answers that cite ledger rows — and
a new timesheet row entered in the TropiTrack app appears in her activity feed.

Milestone 2 is Omar's daily crew log (the first write). Milestone 3 is the money loop —
receipts, invoices, and the confirmed-received flag.
