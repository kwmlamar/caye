import 'server-only'

/**
 * ChargeAnywhere payment-link client — SCAFFOLD, not yet wired to the
 * real API.
 *
 * ChargeAnywhere's actual request/response shapes and auth scheme live
 * behind a merchant-gated developer portal (chargeanywhere.com/developers/
 * redirects to a login) plus a signed API License and Terms of Service
 * Agreement. We don't have Karenda's merchant credentials or the real
 * endpoint docs, so guessing at a request body would risk a payment link
 * that silently fails or is malformed against the live API. createPaymentLink
 * below throws instead of pretending to call anything.
 *
 * The product Karenda already uses manually is ChargeAnywhere's "Bill
 * Presentment" — emails an invoice with a "Click here to Process Payment"
 * link. That's the endpoint this should eventually call.
 *
 * To wire this up for real:
 * 1. Karenda requests API/developer access on her ChargeAnywhere merchant
 *    account (ask her account rep for Bill Presentment API access).
 * 2. Get merchant ID + API key + base URL + the invoice-create endpoint
 *    spec from ChargeAnywhere.
 * 3. Set CHARGEANYWHERE_API_KEY / CHARGEANYWHERE_MERCHANT_ID /
 *    CHARGEANYWHERE_API_BASE_URL in .env.local + Vercel.
 * 4. Replace the throw in createPaymentLink with the real request.
 */

export class ChargeAnywhereNotConfiguredError extends Error {
  constructor() {
    super(
      'ChargeAnywhere API is not configured yet — missing credentials and endpoint docs. See lib/payments/chargeanywhere.ts.'
    )
    this.name = 'ChargeAnywhereNotConfiguredError'
  }
}

export interface CreatePaymentLinkArgs {
  amount: number
  description: string
  customerName: string
  customerEmail?: string | null
}

export interface PaymentLinkResult {
  url: string
  invoiceNumber: string
}

function isConfigured(): boolean {
  return Boolean(
    process.env.CHARGEANYWHERE_API_KEY &&
      process.env.CHARGEANYWHERE_MERCHANT_ID &&
      process.env.CHARGEANYWHERE_API_BASE_URL
  )
}

export async function createPaymentLink(_args: CreatePaymentLinkArgs): Promise<PaymentLinkResult> {
  if (!isConfigured()) {
    throw new ChargeAnywhereNotConfiguredError()
  }

  // TODO: real ChargeAnywhere Bill Presentment call, once credentials and
  // the endpoint spec are in hand. Do not guess at the request shape.
  throw new ChargeAnywhereNotConfiguredError()
}
