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

  it('mirrors the scan crons\' real finding, not a "check Caye Direct" pointer', () => {
    // 2026-08-13: operators here are WhatsApp-only by design (repo CLAUDE.md)
    // and are never expected to open a dashboard — the vague "full write-up
    // is in Caye Direct; say the word..." ping is exactly what the brief
    // asked to remove.
    const finding = "Karin's deposit invoice is still open — she followed up again this morning."
    const scanBody = operatorPingLogBody('opportunity_scan', { freeFormBody: finding })
    expect(scanBody).toBe(finding)
    expect(scanBody.toLowerCase()).not.toContain('caye direct')

    const insightBody = operatorPingLogBody('business_insights', { freeFormBody: 'Snorkel tours up 12% this month.' })
    expect(insightBody).toBe('Snorkel tours up 12% this month.')
    expect(insightBody.toLowerCase()).not.toContain('caye direct')
  })

  it('never mentions Caye Direct even on the no-content fallback path', () => {
    const scanFallback = operatorPingLogBody('opportunity_scan', {})
    const insightFallback = operatorPingLogBody('business_insights', {})
    expect(scanFallback.toLowerCase()).not.toContain('caye direct')
    expect(insightFallback.toLowerCase()).not.toContain('caye direct')
    expect(detectInternalLeak(scanFallback)).toBeNull()
    expect(detectInternalLeak(insightFallback)).toBeNull()
  })

  // CAY-12 — the two exact sentences from Mrs. Max's real operator thread
  // that motivated this file's regression coverage. Composed end-to-end
  // through the same urgent_hold fallback template that produced them live,
  // not hand-assembled, so a future change to the template or its inputs
  // re-exercises the actual failure mode.
  describe('urgent_hold — real production leaks (CAY-12)', () => {
    it('never renders the raw evidence-gate code (Pam Ott, 2026-08-17)', () => {
      // Shipped as: "Pam Ott came in — availability_claim_unverified. Want
      // me to take a first pass, or you got this one?" — a caller had
      // written evidenceVerdict.reasons[0] straight into the ping payload's
      // `reason` field instead of the human label (ownerReasonLabelFor).
      const body = operatorPingLogBody('urgent_hold', {
        contactName: 'Pam Ott',
        reason: 'availability_claim_unverified',
      })
      expect(body).not.toContain('availability_claim_unverified')
      expect(detectInternalLeak(body)).toBeNull()

      // The actual producer (lib/whatsapp/triggers.ts's enqueueHoldPing) is
      // only ever fed decision.reason, which lib/caye-reply.ts now sets via
      // ownerReasonLabelFor for this exact case — confirm that composes into
      // a clean ping too.
      const realBody = operatorPingLogBody('urgent_hold', {
        contactName: 'Pam Ott',
        reason: 'Needs availability confirmation',
      })
      expect(realBody).toBe(
        'Pam Ott came in — Needs availability confirmation. Want me to take a first pass, or you got this one?'
      )
      expect(detectInternalLeak(realBody)).toBeNull()
    })

    it('never renders the raw escalation category or "would have escalated" narration (Ruslan Prakapovich, 2026-08-17/CAY-12 follow-up)', () => {
      // Shipped as: "Ruslan Prakapovich came in — Thread is held for a
      // human — Caye did not reply (would have escalated: sensitive). Want
      // me to take a first pass, or you got this one?" — applyAutosendGate
      // wrote the raw EscalationCategory enum into the reason. Translating
      // the enum to prose wasn't enough either: "would have escalated" is
      // routing-engine narration a human employee would never say, so the
      // whole shape is forbidden regardless of what follows it.
      const body = operatorPingLogBody('urgent_hold', {
        contactName: 'Ruslan Prakapovich',
        reason: 'Thread is held for a human — Caye did not reply (would have escalated: sensitive)',
      })
      expect(body).not.toMatch(/would have escalated/i)
      expect(detectInternalLeak(body)).toBeNull()

      // The real producer no longer writes "would have escalated" at all —
      // applyAutosendGate composes a direct reason from the translated
      // category instead (lib/autosend-gate.ts).
      const realBody = operatorPingLogBody('urgent_hold', {
        contactName: 'Ruslan Prakapovich',
        reason: 'Thread is held for a human — Caye did not reply — a sensitive or commercial matter',
      })
      expect(realBody).not.toMatch(/would have escalated/i)
      expect(detectInternalLeak(realBody)).toBeNull()
    })
  })

  describe('booking_created — honest state language (2026-08-26 Autumn McNeill incident, fixture C)', () => {
    // "Just booked — Autumn McNeill, North Bimini Heritage Tour on
    // Saturday, September 5 at 09:00, 2 guests." was sent for a booking
    // whose real status was pending, no payment link sent, no payment
    // confirmed. A booking ROW existing is not the same as the customer
    // being booked. stateLabel (lib/whatsapp/triggers.ts's
    // bookingStateLabel) now carries the real status through the payload.
    it('never says "Just booked" for a pending booking', () => {
      const body = operatorPingLogBody('booking_created', {
        guest: 'Autumn McNeill',
        summary: 'North Bimini Heritage Tour on Saturday, September 5 at 09:00, 2 guests',
        stateLabel: 'New pending booking',
      })
      expect(body).not.toMatch(/just booked/i)
      expect(body).toMatch(/New pending booking/)
      expect(body).toContain('Autumn McNeill')
    })

    it('says "Booking confirmed & paid" honestly when that is actually true', () => {
      const body = operatorPingLogBody('booking_created', {
        guest: 'Sonja',
        summary: 'Full Bimini Experience on Wednesday, August 26',
        stateLabel: 'Booking confirmed & paid',
      })
      expect(body).toMatch(/Booking confirmed & paid/)
      expect(body).not.toMatch(/just booked/i)
    })

    it('degrades to a neutral, still-honest label for a legacy queue row with no stateLabel', () => {
      // Rows enqueued before this field existed have no payload.stateLabel.
      const body = operatorPingLogBody('booking_created', {
        guest: 'A guest',
        summary: 'a tour',
      })
      expect(body).not.toMatch(/just booked/i)
      expect(detectInternalLeak(body)).toBeNull()
    })
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
