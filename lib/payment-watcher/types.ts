/**
 * A payment signal found in one inbound email — a bank deposit alert, or a
 * client saying money moved. Detection only; whether it is TRUE is never
 * decided here or anywhere in this module. See detection.ts's header.
 */
export type PaymentDirection = 'inbound' | 'outbound' | 'unknown'

export interface PaymentSignal {
  isPaymentSignal: boolean
  direction: PaymentDirection
  amount: number | null
  reference: string | null
  senderName: string | null
  senderEmail: string | null
  senderDomain: string | null
  /** Sender domain matched a known bank's — the brief's "highest confidence" source. */
  isBankSender: boolean
  evidence: string[]
}

/**
 * An open invoice, narrowed to what matching.ts needs. `clientEmailDomain` is
 * resolved by the caller (propose.ts) via a client lookup — matching.ts stays
 * pure and never talks to Bedrock itself, mirroring lib/freight/matching.ts.
 */
export interface InvoiceCandidate {
  id: string
  invoiceNumber: string | null
  clientName: string | null
  balanceDue: number
  clientEmailDomain: string | null
}

export type InvoiceMatchStatus = 'MATCHED' | 'AMBIGUOUS' | 'NO_MATCH'
/** EXACT: amount equals balance_due. PARTIAL: amount is less than balance_due. */
export type InvoiceMatchConfidence = 'EXACT' | 'PARTIAL'

export interface RankedInvoiceMatch {
  candidate: InvoiceCandidate
  confidence: InvoiceMatchConfidence
  reasons: string[]
}

export interface InvoiceMatchResult {
  status: InvoiceMatchStatus
  /** Set only when status is MATCHED — exactly one candidate, never guessed. */
  selection: RankedInvoiceMatch | null
  /** Every candidate the sender could plausibly match, for AMBIGUOUS/NO_MATCH reporting. */
  candidates: RankedInvoiceMatch[]
}
