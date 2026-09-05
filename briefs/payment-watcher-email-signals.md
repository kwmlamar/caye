# Payment Watcher — email signals (propose-only)

## Status

Implemented alongside this brief, on `feat/payment-watcher-email-signals`. Not merged by
the implementing agent — see CLAUDE.md's engineering rules on who may merge.

## Why this reopens a boundary drawn on purpose

`briefs/ods-receivables-loop.md` — the design that built `get_receivables` and
`record_payment` — drew this line deliberately:

> Any bank integration. None exists and none is proposed here — this milestone is explicitly
> the design that works *without* one.

That was the right call at the time: the receivables loop needed to work with nothing but
TropiTrack's own invoice dates and a human's word, and it does. But the gap it built around
is still there. `payments` still has zero rows. Every invoice still reads `amount_paid =
0.00`. The money has been arriving — a client confirmed wiring a payment in August — and
none of it ever became a record, because writing one down still means someone opening
TropiTrack and typing it in, and nobody does.

This is not a reversal of the receivables loop's rule. It is the same rule, fed by a better
signal. **A client saying they paid is not a payment. Neither is a bank alert, a deposit
notification, or anything else short of a human confirming the money is actually in the
account** (`lib/caye-agent/tools/write-high/record-payment.ts`'s own doc comment). What
changes is *how much work* confirming that costs a human: instead of opening TropiTrack,
finding the invoice, and typing in every field, they read one WhatsApp message with the
amount, the invoice, and the source already filled in, and say yes or no.

## The one rule, unchanged

**Caye never writes a payment. Ever.** Every proposal this produces stages a
`record_payment` call through the exact same code-enforced confirmation gate
(`gateHighRisk` / `caye_pending_actions` / `confirm_pending_action`) every other high-risk
action in this codebase already goes through — the same mechanism a human typing "record
$3,200 against invoice X" in chat would trigger. A cron detecting an email gets no more
authority than that: `ctx.origin: 'scan'` means a payment-watcher proposal can stage itself,
but structurally cannot confirm itself (`lib/caye-agent/tools/high-risk-gate.ts`), the exact
guarantee the opportunity-scan cron already relies on for every other autonomous proposal in
this codebase.

**Caye owns the gate. TropiTrack owns the ledger.** The proposal is staged and confirmed
inside Caye's own surface (WhatsApp) — Wallace should not have to log into TropiTrack to
confirm a wire he already saw land — but the actual write still lands in TropiTrack's
`payments` table, and `invoices.amount_paid`/`balance_due` still recalculate via
TropiTrack's own trigger, never something Caye computes herself.

## What it does

Watches Gmail (the same inbound path every other Caye feature already reads,
`app/api/email/gmail-poll/route.ts`) for a payment signal — a bank deposit alert, or a
client saying money moved — and tries to match it against an open TropiTrack invoice:

- **Exact**: amount equals the balance due on exactly one client-matched invoice.
- **Partial**: amount is less than the balance due on exactly one client-matched invoice.
- **Ambiguous**: more than one invoice could plausibly be it — never picked, every candidate
  surfaced.
- **No match**: no open invoice matches at all. See below — this is the expected common
  case right now, not a failure mode.

A matched or partial signal stages a `record_payment` proposal exactly as if an operator had
typed it in chat, and raises it into `caye_owner_attention` so it reaches Wallace over
WhatsApp on the existing 30-minute construction-ledger delivery cadence
(`lib/construction-attention-delivery.ts`) — no new send path, no new delivery mechanism.

## No-match is the dominant path at launch, not the edge case

TropiTrack currently holds 8 invoices, all stale imports, none reflecting current work. Most
real deposits will therefore fail to match on day one — that is a fact about the invoice
ledger's current state, not a defect in the matcher. A no-match proposal is priced
accordingly: `awareness`, not `critical` (deliberately different from
`lib/freight-attention.ts`'s NO_MATCH rule, which treats absence of any watching process as
urgent — here the volume itself would make `critical` noise, not signal). But it still
carries everything needed to act on it later without re-hunting the inbox: amount, date,
sender name and domain, any reference number, and a link back to the source email — so
acting on it once the right invoice exists is filling in one field, not re-deriving the
signal from scratch.

## Deliberately shipped inert: the weekly Friday aging nudge

The brief that started this work also asked for a Friday digest of invoices over 30 days
with nothing recorded against them. That code is built
(`lib/payment-watcher/weekly-aging-nudge.ts`,
`app/api/caye/payment-watcher/weekly-nudge/cron/route.ts`) but **ships disabled by default**
behind `PAYMENT_WATCHER_WEEKLY_NUDGE_ENABLED`, checked before anything runs. Against
TropiTrack's current 8 stale invoices — $94,178.46 total, at least one of which a client has
already confirmed wiring — this digest would be loudly wrong on its first send, and a nudge
that's wrong the first time gets muted forever. Turn it on once the invoice ledger reflects
real work, as a deliberate, separate decision — not as a side effect of merging this.

## Known limitation

`payment_method` stages as `bank_transfer` unconditionally. A client who says they paid by
cheque in the email body is not detected as such — the human confirming can correct it
before (or instead of) approving, but this pass does not parse payment method from the
email text.

## Out of scope (this pass)

- **Statement import.** Reconciling an actual bank statement (PDF/CSV) against invoices is
  real, independent work — email tells you fast, a statement tells you true, and this pass
  only builds the first. When built, it follows the existing document-understanding pattern
  (`lib/artifacts/understand.ts` — an LLM vision call, strict JSON schema out) for both PDF
  and CSV, rather than adding a CSV-parsing dependency this codebase doesn't otherwise carry.
- Sending anything to a client. Unchanged from the receivables loop: Caye may draft a chase,
  never send one, and this feature sends nothing at all.
- Cash position. Same reasoning as the receivables loop — matching a signal is not knowing
  the bank balance.

## Acceptance

1. A bank alert or client "wire sent" email produces a staged, human-confirmable proposal
   within one Gmail poll cycle, with the source email linked.
2. No `payments` row is ever written except through an explicit, real WhatsApp confirmation
   — verified by construction: the write path is the unmodified `record_payment` tool,
   behind the unmodified `gateHighRisk`/`confirm_pending_action` gate.
3. A failure inside detection or matching cannot stop Gmail polling for any other message.
4. An ambiguous match is always surfaced with every candidate, never guessed.
5. The weekly nudge exists, is wired into delivery, and sends nothing until explicitly
   enabled.
