# Grounded invoice proposal

The join between a freight document request and the money it implies.

## Audit that produced this module (origin/main @ b29a176d)

The ODS estimate-to-invoice workflow was six independent pieces with three
breaks between them.

**What already existed and works.** `lib/freight/` detects a freight document
request deterministically (`detection.ts`), normalizes purchase artifacts into
`PurchaseEvidence` (`evidence.ts`), ranks candidates against the request
(`matching.ts`), renders a document (`document.ts`), and gates authority
(`authorization.ts`). `app/api/founder/freight-workflow/route.ts` drives all of
it behind an owner/founder approval step with a conversation-execution claim,
artifact ingest, provenance relations, and workspace events.
`lib/domain-adapters/bedrock/` reads ODS's authoritative construction state —
projects, estimates with sections and line items, purchase orders, receipts —
read-only, company-scoped, fail-closed.

**Break 1 — the document was not an invoice.** The pipeline terminated in a
`FREIGHT DOCUMENT` that transcribed one receipt. There was no invoice concept
anywhere in the repository: no proposal type, no addressee, no reconciliation,
and `BedrockEntityType` has no `invoice` member. Estimate-to-invoice was
unimplemented in the literal sense that the estimate side and the invoice side
never met.

**Break 2 — no arithmetic was ever checked.** `buildFreightDocumentData`
printed the receipt's stated `TOTAL` beside lines it never summed. On a freight
document that is a transcription error; on an invoice it is an unverified
number a business would be asked to stand behind.

**Break 3 — Caye could not reach any of it.** `detectFreightRequest` had exactly
one caller: a founder dashboard route, invoked lazily on `GET`. The agent tool
registry contained no freight or construction tool, so the employee could not
see a freight request, the evidence behind it, or the estimate it came from.
Nothing in the product could investigate one of these requests without a person
opening a specific dashboard screen first.

Two smaller gaps fell out of the same read. `detectFreightRequest` has always
reported `consolidationMentioned` and nothing consumed it, so a consolidated
shipment silently produced a document for one receipt out of several. And
`FreightWorkflow` (`lib/freight/workflow.ts`) is a fully implemented, fully
tested state machine with no production caller — the route reimplements it
inline against Supabase, and the two disagree about workflow identity. That
duplication is real but is untouched here: consolidating live production code
needs its own change with its own proof of caller equivalence.

## What this module adds

- `types.ts` — the proposal shape, using the same `fact` / `inference` /
  `unknown` vocabulary and provenance model as
  `lib/operational-intelligence/brief.ts`. Every number says whether it was
  read, derived, or is not established.
- `reconcile.ts` — integer-cent arithmetic over the lines, tax, shipping and
  stated total. Returns what agreed, what did not, and what could not be
  checked. Never a bare boolean.
- `estimate-basis.ts` — the estimate join. Matches a purchased description to a
  Bedrock estimate line item by shared significant tokens, and resolves ties to
  no basis rather than to a guess.
- `build.ts` — pure, deterministic assembly. Aggregates every matched purchase
  (closing the consolidation gap), attaches provenance to every line, names
  every gap, and classifies readiness.
- `compose.ts` — orchestration over an injected read interface. Reuses
  `rankPurchaseEvidence` rather than adding a second matching path.
- `supabase-source.ts` — the production reads, mirroring the queries the
  founder route already runs so a proposal is built from exactly the evidence a
  human reviewer would see.

## Safety properties

- **Read-only end to end.** `InvoiceProposalSource` has no write member, so no
  caller of `composeInvoiceProposal` can persist or send. The agent tool is
  `risk: 'read'` and is absent from `HIGH_RISK_TOOLS` because it stages nothing.
- **A proposal is not a document and not a send.** `ProposalReadiness` has no
  value meaning "send". Generating and delivering the real document stays on
  the existing owner-approval path, which owns the execution claim and the
  Gmail send.
- **Workspace isolation is enforced, not assumed.** `buildInvoiceProposal`
  throws on evidence or an estimate from another workspace;
  `composeInvoiceProposal` filters foreign evidence before ranking.
- **Refusal is a first-class outcome.** No match, ambiguity, unreconciled
  totals, mixed currency, an unpriced line, an unnamed supplier, or a
  consolidation with one matched purchase each produce a named blocking reason
  instead of a plausible number.

## What still blocks full autonomy

This module closes the reasoning and reachability gaps. Two remain, both
deliberately out of scope here:

1. **Nothing notices a freight request when it arrives.** Detection still runs
   only when something asks for it. An inbound observer that raises the request
   into the attention path is a separate change against the perception
   pipeline.
2. **Project and estimate resolution is caller-supplied.** `estimate_id` must
   be passed in; nothing infers the project a dock receipt belongs to. That
   inference needs its own grounding rules before it can drive money.
