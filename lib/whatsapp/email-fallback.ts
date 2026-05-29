import 'server-only'
import { createServiceClient } from '@/lib/supabase-server'
import { sendZohoReply } from '@/lib/email-ai'

/**
 * Email fallback for urgent Caye→operator pings that failed to deliver on
 * WhatsApp. Only invoked for kinds where silence is dangerous:
 *   - urgent_hold
 *   - same_day_booking
 *   - auth_failure
 *
 * Sends via the workspace's own Zoho Mail account to the operator's signup
 * email. If Zoho isn't connected (e.g. the auth_failure IS Zoho), we log and
 * give up — there is no second fallback in v1.
 */

export interface FallbackInput {
  workspaceId: string
  kind: 'urgent_hold' | 'same_day_booking' | 'auth_failure'
  payload: Record<string, unknown>
}

export async function emailFallbackForFailedPing(input: FallbackInput): Promise<void> {
  const { workspaceId, kind, payload } = input
  const supabase = createServiceClient()

  // Resolve operator signup email. customers.email is the workspace owner.
  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('contact_email, full_name')
    .eq('id', workspaceId)
    .maybeSingle()

  if (custErr || !customer?.contact_email) {
    console.warn(`[email-fallback] No operator email for workspace ${workspaceId}`)
    return
  }

  const { subject, body } = composeFallback(kind, payload)

  try {
    // threadId is only used for logging inside sendZohoReply — a synthetic id is fine.
    await sendZohoReply(
      customer.contact_email,
      subject,
      body,
      `caye-fallback-${workspaceId}-${Date.now()}`,
      workspaceId
    )
  } catch (err) {
    console.error(`[email-fallback] Zoho send failed for ${workspaceId}:`, err)
  }
}

function composeFallback(
  kind: FallbackInput['kind'],
  payload: Record<string, unknown>
): { subject: string; body: string } {
  const dashboardUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://meetcaye.com'

  switch (kind) {
    case 'urgent_hold': {
      const contact = (payload.contactName as string) ?? 'A guest'
      const reason = (payload.reason as string) ?? 'needs your call'
      const draft = (payload.proposedReply as string) ?? ''
      return {
        subject: `Caye couldn't reach you on WhatsApp — ${contact} needs your call`,
        body:
          `${contact} is waiting on you.\n\nReason: ${reason}\n\n` +
          (draft ? `Draft I had ready:\n${draft}\n\n` : '') +
          `Open the dashboard to send or edit: ${dashboardUrl}\n\n— Caye`,
      }
    }
    case 'same_day_booking': {
      const guest = (payload.guest as string) ?? 'A guest'
      return {
        subject: `Caye couldn't reach you on WhatsApp — booking for today: ${guest}`,
        body:
          `${guest} booked for today. I auto-confirmed it.\n\n` +
          `Details: ${dashboardUrl}\n\n— Caye`,
      }
    }
    case 'auth_failure': {
      const service = (payload.service as string) ?? 'a connected service'
      const reconnectUrl = (payload.reconnectUrl as string) ?? dashboardUrl
      return {
        subject: `Caye couldn't reach you on WhatsApp — ${service} disconnected`,
        body:
          `${service} disconnected and I can't reach you on WhatsApp either.\n\n` +
          `Reconnect: ${reconnectUrl}\n\n— Caye`,
      }
    }
  }
}
