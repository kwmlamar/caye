import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
// The route pulls in the whole send stack. None of it is exercised by the
// pure body composer under test; stubbed so the module imports outside a
// Next server runtime.
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
import { detectInternalLeak } from '@/lib/operator-text-guard'

/**
 * What renders in Caye Direct for a ping that went out over WhatsApp.
 *
 * On 2026-08-12 this function's `default:` branch returned `[${kind}]`, and
 * `operator_reminder` had no case — so the literal string
 * "[operator_reminder]" appeared in a paying customer's message thread,
 * underneath a real briefing. `dropped_confirmation` had the same hole.
 * Both composed real text for the WhatsApp send; only the dashboard mirror
 * was broken, which is exactly the kind of drift that survives review.
 */
describe('operatorPingLogBody — no internal identifiers reach the operator', () => {
  it('renders the reminder the owner actually asked for', () => {
    // Requirement 1.
    const body = operatorPingLogBody('operator_reminder', {
      body: 'Reminder: call the dive shop about Saturday, 9:00am.',
    })
    expect(body).toBe('Reminder: call the dive shop about Saturday, 9:00am.')
    expect(body).not.toContain('operator_reminder')
    expect(body).not.toMatch(/\[/)
  })

  it('renders the dropped-confirmation sweep text, not its enum', () => {
    // Requirement 2.
    const body = operatorPingLogBody('dropped_confirmation', {
      body: "You approved the reply to Jeff at 4:10pm and I never sent it — want it to go now?",
    })
    expect(body).toMatch(/You approved the reply to Jeff/)
    expect(body).not.toContain('dropped_confirmation')
  })

  it('mirrors the composed brief verbatim, so WhatsApp and the dashboard agree', () => {
    const brief = 'B2B enquiry — needs your call.\n\nRuslan at Accessible Travel Solutions…'
    expect(operatorPingLogBody('escalation', { brief })).toBe(brief)
  })

  it('mirrors the narrative digest verbatim', () => {
    const narrativeBody = "Morning, Mrs. Max — calendar's empty today."
    expect(operatorPingLogBody('morning_digest', { narrativeBody })).toBe(narrativeBody)
  })

  it('falls back to human prose when the template was sent instead', () => {
    // Window closed / composition failed — no free-form body exists, so the
    // mirror describes what the template said, still in Caye's voice.
    const body = operatorPingLogBody('morning_digest', { heldCount: 3, bookingsTodayCount: 1 })
    expect(body).toMatch(/3 threads holding for you/)
    expect(detectInternalLeak(body)).toBeNull()
  })

  it('NEVER echoes an unmapped kind', () => {
    // Requirement 10, and the actual defect. A kind nobody has written a case
    // for must degrade to something a human would say.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const body = operatorPingLogBody('some_future_kind', {})
    expect(body).not.toContain('some_future_kind')
    expect(body).not.toMatch(/\[.*\]/)
    expect(detectInternalLeak(body)).toBeNull()
    // The diagnostic still exists — it just belongs in the logs, not in a
    // customer's WhatsApp thread.
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('some_future_kind'))
    spy.mockRestore()
  })

  it('degrades rather than forwarding a composed body that carries machinery', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const body = operatorPingLogBody('escalation', {
      brief: 'Forced escalation — b2b_partnership (inbound classifier — B2B / partnership voice).',
    })
    expect(detectInternalLeak(body)).toBeNull()
    expect(body).not.toMatch(/b2b_partnership/)
    spy.mockRestore()
  })

  it('produces clean text for every loggable kind, with and without a payload', () => {
    // The generalisation: no kind that can be logged may produce machinery,
    // whichever branch it takes.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const kind of OPERATOR_LOGGABLE_KINDS) {
      for (const payload of [{}, { body: 'x', brief: 'y', narrativeBody: 'z' }]) {
        const body = operatorPingLogBody(kind, payload)
        expect(body.length, kind).toBeGreaterThan(0)
        expect(detectInternalLeak(body), kind).toBeNull()
        expect(body, kind).not.toBe(`[${kind}]`)
      }
    }
    spy.mockRestore()
  })
})
