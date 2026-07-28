import 'server-only'
import { Resend } from 'resend'

/**
 * Founder-alert email transport — deliberately independent of WhatsApp.
 *
 * founder-alert.ts's whole job is to tell Lamar when the WhatsApp channel
 * is broken. Sending that alert *over* WhatsApp means an account-fatal
 * failure (WABA billing, account disabled) silences the alarm for the
 * exact same reason it's firing. Confirmed live 2026-07-27:
 * caye_founder_alert_log had 4 rows total against 93 undelivered operator
 * pings over 14 days — the one time the alert tried to fire, it used the
 * same broken channel. See briefs/whatsapp-delivery-reliability.md.
 *
 * Resend chosen over reusing the TropiTech Outreach workspace's Zoho OAuth
 * connection specifically because that token can expire silently — an
 * alarm-of-last-resort can't depend on a credential with its own decay
 * clock. One dep, one API key, no auth flow to babysit.
 */
export async function sendFounderAlertEmail(args: {
  to: string
  subject: string
  body: string
}): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL
  if (!apiKey || !from) {
    console.error('[founder-mailer] RESEND_API_KEY or RESEND_FROM_EMAIL not configured')
    return { ok: false, error: 'resend not configured' }
  }

  try {
    const resend = new Resend(apiKey)
    const replyTo = process.env.RESEND_REPLY_TO_EMAIL
    const { error } = await resend.emails.send({
      from,
      to: args.to,
      subject: args.subject,
      text: args.body,
      ...(replyTo ? { replyTo } : {}),
    })
    if (error) {
      console.error('[founder-mailer] send failed:', error)
      return { ok: false, error: error.message }
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[founder-mailer] send threw:', message)
    return { ok: false, error: message }
  }
}
