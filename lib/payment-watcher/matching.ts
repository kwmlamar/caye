import type { InvoiceCandidate, InvoiceMatchResult, PaymentSignal, RankedInvoiceMatch } from './types'

const norm = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const CENTS_TOLERANCE = 0.01

/** Fuzzy name overlap, same primitive lib/freight/matching.ts uses for vendor names. */
function nameOverlaps(a: string | null, b: string | null): boolean {
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return false
  return na.includes(nb) || nb.includes(na)
}

function domainMatches(signal: PaymentSignal, candidate: InvoiceCandidate): boolean {
  if (!signal.senderDomain || !candidate.clientEmailDomain) return false
  return signal.senderDomain === candidate.clientEmailDomain.toLowerCase()
}

function referenceMatches(signal: PaymentSignal, candidate: InvoiceCandidate): boolean {
  if (!signal.reference || !candidate.invoiceNumber) return false
  return norm(signal.reference) === norm(candidate.invoiceNumber)
}

/**
 * Is this invoice even plausibly the client who sent the signal? Requires a
 * name or domain match, or an exact reference match — an amount alone is
 * never enough to associate a signal with a client's invoice (two different
 * clients can owe the same $500).
 */
function isClientCandidate(signal: PaymentSignal, candidate: InvoiceCandidate): { yes: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (referenceMatches(signal, candidate)) reasons.push('exact reference match')
  if (nameOverlaps(signal.senderName, candidate.clientName)) reasons.push('sender name overlap')
  if (domainMatches(signal, candidate)) reasons.push('sender domain matches client')
  return { yes: reasons.length > 0, reasons }
}

/**
 * Rank open invoices against a detected payment signal.
 *
 * Deliberately a decision tree, not a point score (unlike
 * lib/freight/matching.ts's rankPurchaseEvidence) — the brief's own rules
 * already are one: exact amount / partial amount / ambiguous / no match.
 * Reusing freight's numeric weights here would obscure that rather than
 * clarify it. What IS carried over from freight is the spirit: never pick
 * between two plausible candidates, and prefer NO_MATCH over a wrong guess.
 *
 * An amount greater than a single candidate's balance_due is treated as no
 * match for that candidate rather than an overpayment — it more likely means
 * the payment covers a different or additional invoice, and record_payment
 * itself refuses to record more than balance_due anyway.
 */
export function rankInvoiceMatches(signal: PaymentSignal, invoices: InvoiceCandidate[]): InvoiceMatchResult {
  const candidates: RankedInvoiceMatch[] = []

  for (const invoice of invoices) {
    const { yes, reasons } = isClientCandidate(signal, invoice)
    if (!yes) continue
    if (signal.amount === null) continue

    const diff = signal.amount - invoice.balanceDue
    if (Math.abs(diff) <= CENTS_TOLERANCE) {
      candidates.push({ candidate: invoice, confidence: 'EXACT', reasons: [...reasons, 'amount equals balance due'] })
    } else if (diff < 0) {
      candidates.push({ candidate: invoice, confidence: 'PARTIAL', reasons: [...reasons, 'amount less than balance due'] })
    }
    // diff > tolerance (amount exceeds this invoice's balance): not a candidate for this invoice.
  }

  if (candidates.length === 0) return { status: 'NO_MATCH', selection: null, candidates: [] }
  if (candidates.length > 1) return { status: 'AMBIGUOUS', selection: null, candidates }

  return { status: 'MATCHED', selection: candidates[0], candidates }
}
