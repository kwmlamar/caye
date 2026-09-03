# ODS Receivables — the confirmation loop

## Status

Design contract for Milestone 3 of `ods-whatsapp-operating-surface.md`. Written before
implementation.

## Why this one and why now

The audit ranks this first, and says so in plain terms:

> *"You are not short of work or short of margin. You have roughly $94,000 you may or may
> not have been paid, and no instrument anywhere that would tell you. Everything else in
> this report is a process problem. This one is a solvency-visibility problem, and it is the
> first thing I would fix."*

Nine payment requests are outstanding or unconfirmed. The company's own tracker shows
**$62,733.67** of it — exactly three of the nine — and the Cash Position tab has never been
filled in: it still reads `ENTER AMOUNT`. **ODS cannot state its own cash balance from any
system.**

TropiTrack already has the tables. `invoices` and `payments` exist, fully shaped, with
**zero rows**.

## The single most important rule

**The bank is the arbiter, and the bank is in no system.**

Caye must never mark an invoice paid because a client said they would pay. The audit
documents exactly this failure: Island Breeze's client wrote *"we will wire the money on
Monday"*, the invoice went out, and 23 days later nothing anywhere records whether the wire
landed. A system that treats a promise as a payment would have closed that as paid.

So: **a `payments` row is a human attestation, nothing else.** `payments.received_by` is NOT
NULL and references a real profile — whoever confirms is on the record. Caye may draft,
chase, age and ask. Caye may not conclude.

## What the schema already gives us

`invoices` carries `sent_at`, `viewed_at`, `paid_at`, `amount_paid`, `balance_due`, and a
status of `draft|sent|viewed|paid|partial|overdue|cancelled|void`. `payments` carries
`payment_date`, `amount`, `payment_method`, `reference_number`, `received_by`.

Two of those fields matter more than the rest:

- **`sent_at`** closes the Sundancer failure. Its register said the final invoice was
  *"drafted… not yet sent"* on the same day it had been sent, with the PDF attached — the
  covering email said the invoice would follow *"separately"* and the register copied the
  note rather than the fact. A recorded `sent_at` makes that unrepresentable.
- **A `payments` row** is the confirmed-received flag the whole audit is missing.

## Scope

Three tools and one question.

| | |
|---|---|
| `get_receivables` | read · what is outstanding, aged from real dates |
| `log_invoice_sent` | low · record that an invoice went out, with its number and amount |
| `record_payment` | **high** · a human attests money arrived; writes the `payments` row |
| the Friday ask | Caye asks the receivables owner about unconfirmed invoices |

### `get_receivables`

- Ages from `issue_date`/`due_date` **computed at read time**. The audit found every day
  counter in ODS's own registers is a hardcoded number — the AR tab read 36/6/0 when the
  true figures were 63/33/19. A stale age is worse than no age because it reads as current.
- Reports `unconfirmed` distinctly from `overdue`. An invoice nobody has checked is a
  different problem from one a client is late paying, and collapsing them hides the first.
- States the total it can see **and** that it cannot see the bank.

### `log_invoice_sent`

- One numbering scheme. The audit found **eight** running simultaneously and three real
  invoices totalling $7,923.45 that appear in no register at all.
- Records `sent_at` at the moment of sending, not later from memory.

### `record_payment`

- `high` risk. It changes what the business believes it is owed.
- Requires an explicit human statement: amount, date, method, and ideally a bank reference.
- **Refuses to infer.** "The client said they paid" is not a payment. If asked to record one
  on hearsay, it says what it needs instead.
- Partial payments are first-class — `amount_paid` and `balance_due` exist, and ODS bills in
  40/30/20/10 and 50/25/25 milestones, so a part payment is normal rather than exceptional.

### The Friday ask

- Asks only about invoices with **no confirmed payment**, oldest first.
- Does not re-ask about one answered this week — the attention ledger's fingerprint rule
  already does exactly this and should be reused rather than reinvented.
- Goes to whoever owns receivables. On this evidence that is Jay: he has run the payroll
  ledger weekly for seven months, which is the same shape of obligation.

## Out of scope

- Sending invoices. Drafting and sending a client document is the draft-before-send path,
  not this milestone.
- Chasing clients directly. Caye drafts a chase; a human sends it.
- Any bank integration. None exists and none is proposed here — this milestone is explicitly
  the design that works *without* one.
- Cash position. Knowing what is owed is not knowing what is in the account, and claiming
  otherwise would repeat the mistake this exists to fix.

## Acceptance

1. *"who owes us money?"* → the outstanding list, aged from real dates, with unconfirmed
   separated from overdue, and an explicit note that the bank is not connected.
2. *"the Christiansen 40% came in, $10,378, wire, Tuesday"* → staged, confirmed, a `payments`
   row written attributed to the person who said it, and the invoice's balance updated.
3. *"the client says they'll wire Monday"* → **no payment recorded.** A follow-up is set
   instead.
4. Friday, unprompted → *"Eight invoices have no confirmed payment. Oldest is Off the Reef,
   $17,575.75, sent 63 days ago. Did any of these land?"*
