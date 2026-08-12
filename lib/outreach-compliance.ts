import 'server-only'

/**
 * CAN-SPAM footer for TropiTech's own cold-outreach email (internal_sales
 * workspace only — see lib/outreach-email.ts, which is the only caller).
 * Deliberately NOT injected into lib/email-ai.ts's sendZohoEmail/
 * sendZohoReply directly: those are shared primitives used by every
 * workspace's Caye deployment (e.g. Bimini's booking correspondence via
 * the dashboard's send_email tool), and a commercial-email compliance
 * footer has no business appearing on a tour operator's customer emails.
 *
 * ⚠ TROPITECH_MAILING_ADDRESS is a placeholder. CAN-SPAM requires a real
 * physical postal address on commercial email — this must be replaced with
 * TropiTech's actual mailing address before outreach_autosend_paused is
 * ever flipped off. Search for this constant before going live.
 */
const TROPITECH_MAILING_ADDRESS = '[TROPITECH ADDRESS — REPLACE BEFORE GOING LIVE]'

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://meetcaye.com'
}

/** The tracked "tried Caye" link embedded in the demo CTA — app/api/r/[token] stamps outreach_leads.tried_at and redirects to the real demo entry point. */
export function buildTrackedDemoLink(demoToken: string): string {
  return `${appUrl()}/api/r/${demoToken}`
}

/** The one-click unsubscribe link — app/api/unsubscribe/[token] sets opted_out_at. Reuses demo_token rather than a second column; the two routes do different, non-conflicting things with the same lookup key. */
export function buildUnsubscribeLink(demoToken: string): string {
  return `${appUrl()}/api/unsubscribe/${demoToken}`
}

/** Appended to every autonomous cold-outreach send. Plaintext, matches the plaintext mailFormat sendZohoEmail/sendZohoReply already use. */
export function buildComplianceFooter(demoToken: string): string {
  return (
    `\n\n---\n` +
    `TropiTech Solutions, ${TROPITECH_MAILING_ADDRESS}\n` +
    `Don't want these emails? Unsubscribe: ${buildUnsubscribeLink(demoToken)}`
  )
}
