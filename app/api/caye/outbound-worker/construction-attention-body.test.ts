import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
// Same stubbing shape as ping-log-body.test.ts: the route pulls in the whole
// send stack, none of which the pure body composer under test touches.
vi.mock('@/lib/supabase-server', () => ({ createServiceClient: () => ({}) }))
vi.mock('@/lib/whatsapp/outbound', () => ({
  sendTemplateWhatsApp: vi.fn(),
  sendFreeFormWhatsApp: vi.fn(),
  enqueueOutbound: vi.fn(),
  deliveryFieldsFromResult: () => ({}),
}))
vi.mock('@/lib/whatsapp/window', () => ({ isWhatsAppWindowOpen: vi.fn() }))
vi.mock('@/lib/whatsapp/email-fallback', () => ({ emailFallbackForFailedPing: vi.fn() }))
vi.mock('@/lib/operator-identity', () => ({ resolveOperatorByPhone: vi.fn() }))
vi.mock('@/lib/whatsapp/schedule', () => ({
  loadScheduleConfig: vi.fn(),
  nextDigestTime: vi.fn(),
  localDayOfWeek: vi.fn(),
}))
vi.mock('@/lib/cron-run-log', () => ({ recordCronRun: vi.fn(), checkStaleCronsAndAlert: vi.fn() }))
vi.mock('@/lib/whatsapp/founder-alert', () => ({ alertFounderOfDeliveryFailure: vi.fn() }))
vi.mock('@/lib/email/founder-mailer', () => ({ sendFounderAlertEmail: vi.fn() }))
vi.mock('@/lib/whatsapp/delivery-errors', () => ({ extractErrorCode: vi.fn() }))
vi.mock('@/lib/whatsapp/template-sync', () => ({ resyncTemplatesAfterParamMismatch: vi.fn() }))
vi.mock('@/lib/pending-operations-worker', () => ({ drainPendingOperationsSafely: vi.fn() }))
vi.mock('@/lib/owner-attention', () => ({ markAttentionNotified: vi.fn() }))

import { operatorPingLogBody, OPERATOR_LOGGABLE_KINDS } from './route'

const TITLE = 'Off the Reef: $17,575.75 outstanding, 63 days, no payment ever recorded'
const NEXT = 'No payment is on record for this one. Check the bank and tell me either way.'

describe('construction_attention operator-facing body', () => {
  it('joins the title and the ask, both composed upstream in domain vocabulary', () => {
    const body = operatorPingLogBody('construction_attention', { title: TITLE, next_action: NEXT })
    expect(body).toContain(TITLE)
    expect(body).toContain(NEXT)
  })

  it('never leaks internal bookkeeping into a message a person reads', () => {
    const body = operatorPingLogBody('construction_attention', {
      title: TITLE,
      next_action: NEXT,
      subject_type: 'receivable',
      subject_id: 'inv-off-the-reef',
      operator_allowlist_id: 31,
      routing_reason: 'Receivable — Lamar chases and logs it.',
      to_phone: '+12425550031',
    })

    // Every one of these is carried on the payload for audit and must stay
    // out of the prose. Internal table/queue language reaching an operator
    // is the failure this asserts against, not a style preference.
    expect(body).not.toMatch(/subject_type|subject_id|operator_allowlist_id|routing_reason|construction_attention|caye_owner_attention|receivable/i)
    expect(body).not.toContain('+12425550031')
  })

  it('states what is on record rather than asserting nobody paid', () => {
    // The integrity rule this path exists under: report what is recorded and
    // say so. "No payment is on record" is a claim about the ledger. Never
    // let this become a dunning notice that asserts the customer has not paid.
    const body = operatorPingLogBody('construction_attention', { title: TITLE, next_action: NEXT })
    expect(body).toMatch(/on record/i)
    expect(body).toMatch(/tell me either way/i)
  })

  it('degrades to something a human would say when the title is missing', () => {
    const body = operatorPingLogBody('construction_attention', {})
    expect(body).toBeTruthy()
    // Must never echo the kind — the bug that put a system token in a paying
    // customer's thread.
    expect(body).not.toMatch(/construction_attention|\[.*\]/)
  })

  it('is operator-loggable, so a closed 24h window does not silently drop it', () => {
    // There is no approved Meta template for this kind, so a closed window
    // means WhatsApp cannot carry it. Being loggable is what makes it land in
    // Caye Direct instead of disappearing — an outstanding invoice reaching
    // nobody is the exact failure this whole path was built to end.
    expect(OPERATOR_LOGGABLE_KINDS.has('construction_attention')).toBe(true)
  })
})
