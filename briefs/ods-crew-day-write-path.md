# ODS Crew Day — the first write into the ledger

## Status

Design contract for Milestone 2 of `ods-whatsapp-operating-surface.md`. Written before
implementation so the write boundary's security properties are settled before any code
opens one.

Everything shipped so far is **read-only against TropiTrack by construction** — the provider
exposes no mutation and the adapter has no write methods, and the adapter's own README states
that as a security property. This brief deliberately changes that. It must be read as a
change to the threat model, not as a feature.

## Goal

Omar reports a crew day in one WhatsApp message. Caye turns it into every timesheet row for
that day, shows him one summary, and writes them only after he confirms.

> *"Blue Sky today — me, Cyril, Dwight, 7 to 4. Cyril left at 2."*

One message. Ten rows. One confirmation.

## Why one message and not ten

Jay has entered 1,529 timesheet rows since January, weekly, without being chased. He is not
the problem and this does not replace him. The gap is that **Omar leaves no record at all** —
the audit found the crews' work is coordinated entirely over WhatsApp and in person, so the
most operationally effective part of ODS is the part with zero institutional memory.

If capture cost Omar ten messages it would not happen. Default-and-confirm is the only shape
that survives contact with someone standing on a roof.

## What the ledger says the defaults are

Not invented — measured against all 3,883 existing entries:

| Fact | Evidence |
|---|---|
| Break is **always 60 minutes** | every one of 3,883 rows |
| Standard day is **07:00–16:00 = 8.0 regular hours** | dominant shift pattern |
| Regular hours only ever take the values 0, 4, 6, 7, 8, 9.5 | a small discrete set |
| **Overtime is rare — 36 rows of 3,883 (0.9%)** | measured |

Two rules follow directly:

- **60 minutes is a defensible default break.** State it in the summary anyway; never let a
  default pass unseen.
- **Caye must never compute overtime.** No overtime policy is recorded anywhere in ODS, and
  guessing one would silently change what a worker is paid. Always write `overtime_hours: 0`
  and say so. Jay corrects it in the app if a day was long.

## The write boundary

A **separate module**, not new methods on the read provider. The read boundary's value is
that it *cannot* mutate; widening it would spend that property permanently.

`lib/domain-adapters/bedrock/write-provider.ts`

- Constructed from a `BedrockConnection` exactly like the read provider.
- **Exactly one capability: insert time entries.** No update, no delete, no other table.
- Every inserted row's `company_id` is forced to the resolved connection's company, whatever
  the caller passed. A caller-supplied company id is never trusted.
- Every write also records a row in TropiTrack's own `audit_logs`, so the two systems agree
  on what happened. TropiTrack's constraints allow exactly:
  `source in (ui, ai, api, system)` · `scope in (read, write)` · `status in (ok, error, denied)`
  · `tier in (none, confirm, double-confirm)`.
  Caye writes `source: 'api'`, `scope: 'write'`, `tier: 'confirm'`.
  **A write that lands without an audit row is a write ODS cannot see.**

## The flow

```
Omar's message
  -> resolve project        (reuse resolveJob — ambiguous means ASK, never guess)
  -> resolve workers        (ambiguous or unknown means ASK, never guess)
  -> build draft rows       (pure function, no I/O)
  -> duplicate check        (read existing entries for that project+date)
  -> STAGE via gateHighRisk -> caye_pending_actions
  -> Omar confirms          -> confirm_pending_action
  -> write                  -> insertTimeEntries + audit_logs
  -> VERIFY                 -> re-read the rows and confirm they exist
```

`risk: 'high'`. Hours feed payroll, payroll is money, and this is the first thing Caye can do
that changes what a person gets paid.

## Rules that are not negotiable

**Never invent a worker.** ODS's active roster includes `Cyrike Tiler`; the audit separately
names a subcontractor called `Cyril`. Those may be two different people. A fuzzy match that
guesses wrong puts one man's hours on another man's pay. Unresolved or ambiguous → return
candidates and ask.

**Never write a duplicate silently.** If entries already exist for a (worker, project, date),
do not add more. Omar re-reporting the same day — easy over WhatsApp, easy after a dropped
connection — would otherwise double the payroll. Report the conflict and require an explicit
instruction to replace.

**A confirmation is not evidence of effect.** After writing, re-read the rows from TropiTrack
and confirm they are there with the values intended. Record the result via the effect
verification ledger. This is the principle that already exists in the codebase and the reason
the Sundancer invoice failure cannot repeat here.

**Partial failure is reported precisely.** If six rows of ten land, say six of ten landed and
name which four did not. Never report a partial write as success, and never roll back silently
in a way that leaves Omar believing the day was logged.

**Nothing ODS-specific in the kernel.** The tool belongs in the agent's tool surface; the
write capability belongs behind the adapter. `log_crew_day` may know what a crew day is;
`caye-agent`'s runtime may not.

## Out of scope for this milestone

- Editing or deleting an existing entry. Correction stays in the TropiTrack app, where Jay
  already works, until a correction flow is designed with the same care.
- Approving timesheets (`approved_by`/`approved_at`) — approval is a separate authority.
- Payroll. Writing hours is not running a pay period.
- Any other table. This milestone opens exactly one write path.

## Acceptance

Over WhatsApp, from Omar's allowlisted phone:

1. *"Blue Sky today — me, Cyril, Dwight, 7 to 4"* → Caye asks which Blue Sky job **and** which
   worker "Cyril" means, because both are genuinely ambiguous.
2. Once disambiguated → a summary naming each worker, hours, the 60-minute break and the zero
   overtime, awaiting confirmation.
3. On confirm → rows exist in TropiTrack, an `audit_logs` row exists beside them, and Caye's
   reply states what was verified rather than what was attempted.
4. Repeating the same message → refused as a duplicate, not written twice.
